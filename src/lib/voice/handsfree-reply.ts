// ─── Correlating a call turn's reply, and speaking it progressively ───────
// The provider sends a call turn with an id it created, then watches the
// transcript for the assistant message that answers it. This module owns those
// rules — which message answers the turn, whether it has failed, and how much
// of a still-streaming reply is safe to speak — so all of it is testable
// without a device, a gateway or React.
//
// Progressive speech is the well-established "speak while the model is still
// generating" technique: synthesizing a completed sentence while later ones
// stream in. The one safety question is whether a streaming message is
// strictly append-only. Rather than branch on which backend produced it (the
// plan forbids that categorically), the provider checks live whether the text
// it already spoke is still a prefix; a mutation falls back to waiting for the
// message to finish, for that turn only.
//
// Because a reply is planned once per streamed delta, the scan hands back the
// position it reached and the next delta resumes from it. Re-reading the whole
// reply per delta made planning quadratic in the reply's length, on the JS
// thread that also dispatches the native level events. The cursor also carries
// a digest of the text the scan settled, so resuming does not cost the check
// that the reply is still append-only — a position alone cannot prove that.
// A sentence terminator that still ends the buffer is not the end of a
// sentence: `Version 3.` may be on its way to `Version 3.14`. The scan holds
// the run, and the next delta or the finish decides whether it ends anything.

import type { ChatMessage } from '@/lib/gateway/types';
import { speechChunks } from '@/lib/voice/speech-chunks';

/**
 * The first assistant message that answers a call turn, or undefined while
 * none has appeared. "Answers" means: it comes after the user turn in the
 * transcript, and it is not a still-running command or a tool card — those
 * belong to the machinery, not the reply.
 */
export function handsfreeReplyForTurn(
  messages: readonly ChatMessage[],
  turnId: string | undefined,
): ChatMessage | undefined {
  if (!turnId) return undefined;
  const start = messages.findIndex((message) => message.id === turnId);
  if (start < 0) return undefined;

  for (const message of messages.slice(start + 1)) {
    if (message.role !== 'assistant') continue;
    if (message.command?.status === 'running') continue;
    if (message.toolCalls?.some((tool) => tool.status === 'running')) continue;
    return message;
  }
  return undefined;
}

/**
 * Whether the reply failed rather than completed: the connection interrupted
 * it, or the stream error was written onto the bubble. A failed reply is never
 * spoken, and ends the call as `send-failed`.
 */
export function isFailedReply(message: ChatMessage): boolean {
  if (message.interrupted) return true;
  return message.text.trimStart().startsWith('Error:');
}

/** Whether the text already spoken is still an unchanged prefix of the reply. */
export function replyPrefixIntact(spoken: string, fullText: string): boolean {
  return fullText.startsWith(spoken);
}

const TERMINATORS = '.!?';

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/**
 * FNV-1a, 32 bit — the digest a cursor carries. A position says how far the
 * scan read, not what it read, and a rewrite leaves the position perfectly valid;
 * a digest is the cheap part of the text that a rewrite cannot keep.
 */
const HASH_BASIS = 0x811c9dc5;

function foldHash(hash: number, code: number): number {
  return Math.imul(hash ^ code, 0x01000193) >>> 0;
}

/** The digest of `text.slice(0, length)`, read forward from the start. */
function prefixHash(text: string, length: number): number {
  let hash = HASH_BASIS;
  for (let index = 0; index < length; index += 1) hash = foldHash(hash, text.charCodeAt(index));
  return hash;
}

/**
 * Where a sentence scan stands. A streaming reply is planned once per delta, and
 * every delta used to re-read the whole reply from index 0 — so a long reply
 * cost O(n) per delta and O(n²) over itself, on the JS thread that also carries
 * the native level events. The cursor is the scan's own position, plus the proof
 * that this text still extends the one the position was reached in, so the next
 * delta picks up where the last one stopped.
 */
export type HandsfreeSpeechCursor = {
  /**
   * How far into the reply the scan has read, which is also what the digest
   * covers. Everything before `boundary` is settled; the characters between it
   * and here have been read, but none of them ends a completed sentence yet.
   */
  index: number;
  /** The longest completed-sentence prefix found so far. */
  boundary: number;
  /** Digest of `fullText.slice(0, index)` as of that scan. */
  hash: number;
  /**
   * Where a run of terminators that ends a still-streaming text begins. Such a
   * run is not a sentence end yet — `Version 3.` may be on its way to
   * `Version 3.14` — so the next scan re-examines it from here, once a delta
   * has put something after it. A finished reply never holds one.
   */
  held?: number;
};

type SpeechScan = {
  /** The longest prefix of the reply that ends on a completed sentence or line break. */
  window: string;
  /** Where the scan stands, for the next delta. */
  cursor: HandsfreeSpeechCursor;
};

type SpeechScanOptions = {
  /** A cursor from an earlier scan of the same, still-appending reply. */
  cursor?: HandsfreeSpeechCursor;
  /**
   * Whether the text may still grow. A terminator that ends a text which may
   * still grow is ambiguous — `Version 3.` may yet become `Version 3.14` — so
   * it is held instead of accepted as a sentence end, and the next scan
   * resolves it once a delta or the finish puts something after it.
   */
  streaming?: boolean;
  /** Told how many characters this scan had to read. */
  onExamine?: (chars: number) => void;
};

/**
 * The longest prefix of a streaming reply that ends on a completed sentence
 * (including the whitespace after it) or a line break. Only then is it safe to
 * hand to the synthesizer: speaking a half-finished word would say something
 * the Bot did not write. Mirrors `speechChunks`'s own terminator rule so the
 * two agree about what a sentence is.
 *
 * A terminator with nothing after it is only the end of a sentence when the
 * text is finished. While the reply is still streaming the same character may
 * be the dot of `3.14`, so it is held: the scan stops in front of the run, the
 * digest still covers it, and the next delta re-reads it from there. The
 * utterance is then spoken once, after the character that resolves it arrives.
 *
 * Given a cursor from an earlier scan of the same, still-appending reply it
 * resumes there instead of walking the settled prefix again; a cursor that does
 * not fit this text is ignored and the scan starts over.
 */
function scanCompletedSentences(text: string, options: SpeechScanOptions = {}): SpeechScan {
  const candidate = options.cursor;
  // A cursor only resumes a text that still extends what it read: a shorter
  // text, a boundary past its own read, or a held run outside it starts over.
  const fits =
    candidate !== undefined &&
    candidate.index <= text.length &&
    candidate.boundary <= candidate.index &&
    (candidate.held === undefined ||
      (candidate.held >= candidate.boundary && candidate.held <= candidate.index));
  const cursor = fits ? candidate : undefined;

  let boundary = cursor ? cursor.boundary : 0;
  // The digest covers everything read so far, a held run included: a rewrite of
  // those characters is a mutation like any other, not a fresh sentence. A
  // resumed scan takes the digest the caller proved; a fresh walk starts from
  // the basis. Either way it only moves forward, so extending it costs the
  // characters this delta added and never a re-read of the prefix.
  let read = cursor ? cursor.index : 0;
  let hash = cursor ? cursor.hash : HASH_BASIS;
  // Resume on the held run rather than after it, so the delta that put
  // something after `3.` resolves the same character the last scan refused.
  let index = cursor ? (cursor.held ?? read) : 0;
  const start = index;
  let held: number | undefined;

  while (index < text.length) {
    const char = text[index];

    if (TERMINATORS.includes(char)) {
      let last = index;
      while (last + 1 < text.length && TERMINATORS.includes(text[last + 1])) last += 1;
      const next = text[last + 1];
      if (next === undefined) {
        // The text ends inside the run. A finished reply ends its sentence on
        // it; a streaming one cannot tell `3.` from the start of `3.14` yet,
        // so the run is held for the next delta or the finish to settle.
        if (options.streaming) held = index;
        else boundary = last + 1;
        index = last + 1;
        continue;
      }
      if (!isWhitespace(next)) {
        // Inside something rather than the end of it (`3.14`, `v1.2.0`).
        index = last + 1;
        continue;
      }
      let end = last + 1;
      while (end < text.length && isWhitespace(text[end])) end += 1;
      boundary = end;
      index = end;
      continue;
    }

    if (char === '\n') {
      let end = index + 1;
      while (end < text.length && isWhitespace(text[end])) end += 1;
      boundary = end;
      index = end;
      continue;
    }

    index += 1;
  }

  while (read < text.length) {
    hash = foldHash(hash, text.charCodeAt(read));
    read += 1;
  }

  // The held run is read again next delta, so it counts as read again here.
  options.onExamine?.(text.length - start);
  const scanCursor: HandsfreeSpeechCursor = { index: read, boundary, hash };
  if (held !== undefined) scanCursor.held = held;
  return { window: text.slice(0, boundary), cursor: scanCursor };
}

/**
 * The longest prefix of a reply that ends on a completed sentence. The
 * whole-reply scan; the incremental plan below resumes this one.
 *
 * `streaming` says the text may still grow, so a terminator that ends it is
 * held rather than accepted (`Version 3.` is not yet a sentence when `14 is
 * out.` may follow). Without it the text is read as finished, and a trailing
 * terminator is the end of the sentence it closes.
 */
export function completedSentenceText(text: string, options?: { streaming?: boolean }): string {
  return scanCompletedSentences(text, { streaming: options?.streaming === true }).window;
}

export type HandsfreeSpeechPlan = {
  /** Chunks to hand the native queue now, in order. */
  chunks: string[];
  /** The exact prefix of the reply those chunks account for. */
  spoken: string;
  /** True when the previously spoken prefix is no longer a prefix of the reply. */
  mutated: boolean;
  /** Where this plan's scan stopped, for the next delta of the same reply. */
  cursor?: HandsfreeSpeechCursor;
};

/**
 * What of a reply is safe to speak right now. A completed reply is spoken in
 * full; a streaming one only up to its last completed sentence, which a
 * terminator that still ends the buffer does not count as — see
 * `completedSentenceText`. After a mutation the plan is empty and names the
 * mutation, and the provider waits for the message to finish before speaking
 * the rest.
 *
 * `cursor` is the previous plan's scan position and the digest of the text it
 * settled. Handing it in keeps the work proportional to the delta rather than to
 * the reply, and leaving it out is exactly the old whole-reply scan.
 */
export function planHandsfreeSpeech(input: {
  fullText: string;
  /** Whether the message is still being written. */
  streaming: boolean;
  /** The exact text already handed to the native queue. */
  spoken: string;
  /** The platform's own maximum chunk length. */
  maxLength: number;
  /** This turn has fallen back to wait-for-completion. */
  waitForCompletion: boolean;
  /** The previous plan's scan position, so this one resumes instead of rescanning. */
  cursor?: HandsfreeSpeechCursor;
  /** Told how many characters this plan had to read. The per-delta cost seam. */
  onExamine?: (chars: number) => void;
}): HandsfreeSpeechPlan {
  let examined = 0;
  // "Is the reply still append-only?" has to cover everything the scan already
  // read: a sentence boundary that survived a rewrite would speak text the Bot
  // took back. A position proves nothing about the characters under it, so the
  // cursor's digest does, in one pass over the settled prefix — against reading
  // all of it every delta for the comparison this replaces. Spoken text beyond
  // that prefix is still compared the old way, as is all of it when there is no
  // cursor to trust (or one from a reply longer than this text).
  const cursor = input.cursor && input.cursor.index <= input.fullText.length ? input.cursor : undefined;
  const settled = cursor?.index ?? 0;
  const spokenIntact = input.fullText.startsWith(input.spoken.slice(settled), settled);
  if (!spokenIntact || (cursor !== undefined && prefixHash(input.fullText, settled) !== cursor.hash)) {
    examined = cursor === undefined ? input.spoken.length : Math.max(0, input.spoken.length - settled);
    input.onExamine?.(examined);
    return { chunks: [], spoken: '', mutated: true };
  }
  examined += Math.max(0, input.spoken.length - settled);
  if (input.waitForCompletion && input.streaming) {
    input.onExamine?.(examined);
    return { chunks: [], spoken: input.spoken, mutated: false, cursor };
  }

  let window: string;
  let nextCursor: HandsfreeSpeechCursor | undefined;
  if (input.streaming) {
    const scan = scanCompletedSentences(input.fullText, {
      cursor,
      streaming: true,
      onExamine: (chars) => {
        examined += chars;
      },
    });
    window = scan.window;
    nextCursor = scan.cursor;
  } else {
    window = input.fullText;
  }
  input.onExamine?.(examined);

  if (window.length <= input.spoken.length) {
    return { chunks: [], spoken: input.spoken, mutated: false, cursor: nextCursor ?? cursor };
  }

  const fresh = window.slice(input.spoken.length);
  const chunks = speechChunks(fresh, input.maxLength);
  if (!chunks.length) {
    return { chunks: [], spoken: input.spoken, mutated: false, cursor: nextCursor ?? cursor };
  }
  return { chunks, spoken: window, mutated: false, cursor: nextCursor ?? cursor };
}

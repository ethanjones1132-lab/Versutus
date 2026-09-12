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
 * The longest prefix of a streaming reply that ends on a completed sentence
 * (including the whitespace after it) or a line break. Only then is it safe to
 * hand to the synthesizer: speaking a half-finished word would say something
 * the Bot did not write. Mirrors `speechChunks`'s own terminator rule so the
 * two agree about what a sentence is.
 */
export function completedSentenceText(text: string): string {
  let boundary = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (TERMINATORS.includes(char)) {
      let last = index;
      while (last + 1 < text.length && TERMINATORS.includes(text[last + 1])) last += 1;
      const next = text[last + 1];
      if (next !== undefined && !isWhitespace(next)) {
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

  return text.slice(0, boundary);
}

export type HandsfreeSpeechPlan = {
  /** Chunks to hand the native queue now, in order. */
  chunks: string[];
  /** The exact prefix of the reply those chunks account for. */
  spoken: string;
  /** True when the previously spoken prefix is no longer a prefix of the reply. */
  mutated: boolean;
};

/**
 * What of a reply is safe to speak right now. A completed reply is spoken in
 * full; a streaming one only up to its last completed sentence. After a
 * mutation the plan is empty and names the mutation, and the provider waits for
 * the message to finish before speaking the rest.
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
}): HandsfreeSpeechPlan {
  if (!replyPrefixIntact(input.spoken, input.fullText)) {
    return { chunks: [], spoken: '', mutated: true };
  }
  if (input.waitForCompletion && input.streaming) {
    return { chunks: [], spoken: input.spoken, mutated: false };
  }

  const window = input.streaming ? completedSentenceText(input.fullText) : input.fullText;
  if (window.length <= input.spoken.length) {
    return { chunks: [], spoken: input.spoken, mutated: false };
  }

  const fresh = window.slice(input.spoken.length);
  const chunks = speechChunks(fresh, input.maxLength);
  if (!chunks.length) {
    return { chunks: [], spoken: input.spoken, mutated: false };
  }
  return { chunks, spoken: window, mutated: false };
}

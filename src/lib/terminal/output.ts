import { ansiPlainText, ansiPlainTextUpTo, ansiSequenceEnd } from '@/lib/terminal/ansi';

export type TerminalLine = {
  id: number;
  text: string;
};

// Strip ANSI/ECMA-48 control sequences from a string, keeping the visible
// text. This shares the renderer's parser so copy, accessibility labels and
// prompt detection agree with the pane about what a control sequence is (SGR,
// other CSI, two-byte escapes, OSC titles through BEL or ST).
export function stripAnsi(text: string): string {
  return ansiPlainText(text);
}

// A single rendered line is bounded so a minified bundle or a giant JSON blob
// cannot pin megabytes in one React child. Unlike a silent truncation, the
// overflow becomes continuation line(s), so the rest of the line stays visible
// and copyable.
const MAX_LINE_LENGTH = 8192;

/** Apply a span's bare carriage returns: each `\r` rewrites the line from
 *  column 0, so a progress bar's redraws collapse to their last state. */
function applyCarriageReturns(current: string, span: string): string {
  const parts = span.split('\r');
  let text = current + parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    text = part + text.slice(part.length);
  }
  return text;
}

/**
 * Split one logical line into rendered lines of about MAX_LINE_LENGTH, cutting
 * only at code-point and escape-sequence boundaries so a surrogate pair or an
 * SGR/OSC sequence is never divided between lines.
 */
function splitLine(text: string): string[] {
  if (text.length <= MAX_LINE_LENGTH) return [text];
  const segments: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + MAX_LINE_LENGTH, text.length);
    if (end < text.length) {
      // A surrogate pair is one code point, so a cut between its halves would
      // leave a lone surrogate in each segment. Keep the pair together.
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      // Never start a continuation with the tail of an escape sequence: move
      // the cut in front of a sequence that would straddle it. A single
      // sequence wider than the cap is carried whole rather than split.
      for (let cursor = at; cursor < end; ) {
        if (text.charCodeAt(cursor) !== 0x1b) {
          cursor += 1;
          continue;
        }
        const sequenceEnd = ansiSequenceEnd(text, cursor);
        if (sequenceEnd <= end) {
          cursor = sequenceEnd;
          continue;
        }
        end = cursor > at ? cursor : Math.max(sequenceEnd, end + 1);
        break;
      }
    }
    segments.push(text.slice(at, end));
    at = end;
  }
  return segments;
}

/**
 * Append a stream chunk to line records, retaining only the newest maxLines.
 *
 * ANSI sequences are preserved in the stored text on purpose — the pane paints
 * colours from them. Bare carriage returns rewrite the current line from its
 * start (progress bars), so redraws collapse to their last state instead of
 * accumulating. A logical line longer than MAX_LINE_LENGTH is split across
 * continuation lines rather than cut: a silently truncated line reads as
 * complete when the operator copies it.
 */
export function appendTerminalChunk(
  lines: TerminalLine[],
  chunk: string,
  maxLines = 2000,
): TerminalLine[] {
  if (!chunk) return lines;

  const next = lines.length > 0 ? [...lines] : [{ id: 0, text: '' }];
  const parts = chunk.split('\n');

  // The first span continues the current line; every later span starts one.
  const logical = [applyCarriageReturns(next[next.length - 1].text, parts[0])];
  for (let index = 1; index < parts.length; index += 1) {
    logical.push(applyCarriageReturns('', parts[index]));
  }

  const [head, ...tail] = logical;
  const firstId = next[next.length - 1].id;
  const headSegments = splitLine(head);
  // Replace, never mutate: a caller may still hold the previous line record.
  next[next.length - 1] = { id: firstId, text: headSegments[0] };
  let id = firstId;
  for (const segment of headSegments.slice(1)) {
    id += 1;
    next.push({ id, text: segment });
  }
  for (const line of tail) {
    for (const segment of splitLine(line)) {
      id += 1;
      next.push({ id, text: segment });
    }
  }

  return next.length > maxLines ? next.slice(-maxLines) : next;
}

export function terminalLinesFromText(text: string): TerminalLine[] {
  return appendTerminalChunk([], text);
}

// ─── Prompt detection ──────────────────────────────────────────────
// Terminal output mixes command echoes, results, and the very prompt itself.
// A line that reads like a shell/CLI prompt gets the signature accent treatment
// so the user can find where the previous command was entered at a glance.

// The visible part of a prompt is short; escape sequences are invisible and
// must not count, so the cap applies after trimming rather than to raw length.
const MAX_PROMPT_LENGTH = 96;

/** True when a line's visible content looks like a shell/CLI prompt. */
export function isPromptLine(text: string): boolean {
  // Bounded scan first: a long visible line is rejected without parsing it in
  // full, while a short prompt wrapped in a long title sequence still matches.
  const visible = ansiPlainTextUpTo(text, MAX_PROMPT_LENGTH);
  if (visible === null || visible.length === 0) return false;
  const match = /([$#>%])[ ]*$/.exec(visible);
  if (!match) return false;
  const stem = visible.slice(0, match.index).trimEnd();
  if (stem.length === 0) return true; // bare `$`, `>`, …
  if (/^\d+$/.test(stem)) return false; // `123$` is output, not a prompt
  // Paths, user@host, drives, home dirs and (env) prefixes are unambiguous.
  if (/[\\/@~]|\(.*\)/.test(stem)) return true;
  // A colon alone is not evidence of a prompt: `Price:` and `CPU usage: 45%`
  // are ordinary output that happens to end in a terminator character.
  if (stem.includes(':')) return false;
  // Short command-style names keep coverage (`mysql>`) without over-matching.
  return stem.length <= 6;
}

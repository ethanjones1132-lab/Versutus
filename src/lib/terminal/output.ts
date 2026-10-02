import { ansiPlainText } from '@/lib/terminal/ansi';

export type TerminalLine = {
  id: number;
  text: string;
};

// Strip CSI/ANSI control sequences from a string. Used for the accessibility
// label of a rendered line and for prompt detection; the visible renderer
// parses the full ANSI so colours survive (see `parseAnsiText`).
const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
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

/** Split one logical line into rendered lines no longer than MAX_LINE_LENGTH. */
function splitLine(text: string): string[] {
  if (text.length <= MAX_LINE_LENGTH) return [text];
  const segments: string[] = [];
  for (let at = 0; at < text.length; at += MAX_LINE_LENGTH) {
    segments.push(text.slice(at, at + MAX_LINE_LENGTH));
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

/** True when a line's visible content looks like a shell/CLI prompt. */
export function isPromptLine(text: string): boolean {
  const visible = ansiPlainText(text).trim();
  if (visible.length === 0 || visible.length > 96) return false;
  const match = /([$#>%])[ ]*$/.exec(visible);
  if (!match) return false;
  const stem = visible.slice(0, match.index).trimEnd();
  if (stem.length === 0) return true; // bare `$`, `>`, …
  if (/^\d+$/.test(stem)) return false; // `123$` is output, not a prompt
  // Paths, user@host, drives and (env) prefixes are unambiguous.
  if (/[\\/@:~]|\(.*\)/.test(stem)) return true;
  // Short command-style names keep coverage (`mysql>`) without over-matching.
  return stem.length <= 6;
}

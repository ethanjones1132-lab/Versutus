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

/**
 * Append a stream chunk to line records, retaining only the newest maxLines.
 *
 * ANSI sequences are preserved in the stored text on purpose — the pane paints
 * colours from them. Only bare carriage returns are removed (progress bars use
 * `\r` to redraw one line, which a list of discrete lines cannot reproduce).
 */
export function appendTerminalChunk(
  lines: TerminalLine[],
  chunk: string,
  maxLines = 2000,
): TerminalLine[] {
  const clean = chunk.replace(/\r/g, '');
  if (!clean) return lines;

  const next = lines.length > 0 ? [...lines] : [{ id: 0, text: '' }];
  const parts = clean.split('\n');
  const last = next[next.length - 1];
  last.text += parts.shift() ?? '';

  for (const part of parts) {
    next.push({ id: (next[next.length - 1]?.id ?? 0) + 1, text: part });
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

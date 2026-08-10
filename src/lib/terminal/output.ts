export type TerminalLine = {
  id: number;
  text: string;
};

// Strip CSI/ANSI control sequences before rendering terminal output as native
// text. This keeps escape codes from leaking into the UI while preserving the
// command output itself.
const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Append a stream chunk to line records, retaining only the newest maxLines. */
export function appendTerminalChunk(
  lines: TerminalLine[],
  chunk: string,
  maxLines = 2000,
): TerminalLine[] {
  const clean = stripAnsi(chunk).replace(/\r/g, '');
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

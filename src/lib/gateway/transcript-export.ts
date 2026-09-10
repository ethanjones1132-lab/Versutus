/**
 * The command transcript as Markdown: the artifact an operator copies off the
 * phone to hand a run or a Bot Chat session to somebody who was not there.
 *
 * The composer holds no state and reaches nothing — no gateway, no store, no
 * clipboard. It reads the entries the transcript view already holds, orders and
 * caps them through the shipped folds in `command-history.ts` (the same newest
 * slice the sheet renders, so the file and the screen cannot disagree), and
 * writes one section per entry: the command's title, its status verbatim and
 * its summary.
 *
 * Honesty rules, all deliberate:
 * - An entry's raw output — the tool-call payloads — is withheld unless the
 *   caller asks for it. Redaction is the default, not a toggle nobody read.
 * - A `raw` that is not a non-blank string is never printed, so a truncated or
 *   older stored entry writes no payload rather than "undefined".
 * - A held set past the visible cap names its bound in the sheet's own words,
 *   so the file never reads as the whole transcript.
 */
import type { CommandTranscriptEntry } from '@/lib/gateway/types';
import {
  commandHistoryEmptyCopy,
  commandHistoryRowTitle,
  commandHistoryVisible,
  commandHistoryWindowCopy,
} from '@/lib/gateway/command-history';

export type CommandTranscriptExportOptions = {
  /**
   * Append each entry's raw output verbatim. Off unless this is exactly
   * `true` — the redaction the spec asks for, applied by default.
   */
  includeRaw?: boolean;
};

/**
 * The raw output this entry may print, or undefined when there is none to
 * print. A stored value that is not a string (or is blank) is not output.
 */
function printableRaw(entry: CommandTranscriptEntry): string | undefined {
  const raw = entry.raw;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw;
}

/**
 * The raw output as one fenced block. The fence grows past any backtick run
 * inside the payload, so output that holds its own fence cannot break out of
 * the block and swallow the sections after it.
 */
function rawBlock(raw: string): string {
  const longestRun = (raw.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${raw}\n${fence}`;
}

/**
 * The whole held transcript as Markdown, newest command first. Mirrors the
 * command-history section: the newest visible slice, the sheet's own bound line
 * when the held set runs past it, and the sheet's own empty note when nothing
 * was held.
 */
export function commandTranscriptMarkdown(
  entries: CommandTranscriptEntry[],
  options: CommandTranscriptExportOptions = {},
): string {
  const held = commandHistoryVisible(entries);
  const lines: string[] = ['# Command history', ''];

  const windowCopy = commandHistoryWindowCopy(entries.length);
  if (windowCopy) lines.push(`_${windowCopy}_`, '');

  if (held.length === 0) {
    lines.push(commandHistoryEmptyCopy(), '');
    return lines.join('\n');
  }

  for (const entry of held) {
    lines.push(`## ${commandHistoryRowTitle(entry)}`, '');
    lines.push(`- Status: ${entry.status}`);
    lines.push(`- Summary: ${entry.summary}`);
    lines.push('');

    const raw = options.includeRaw === true ? printableRaw(entry) : undefined;
    if (raw !== undefined) {
      lines.push('### Raw output', '', rawBlock(raw), '');
    }
  }

  return lines.join('\n');
}

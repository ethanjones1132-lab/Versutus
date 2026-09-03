/**
 * The command transcript: every slash execution the gateway provider records
 * (`appendTranscript` in `transcript.ts`), keyed by gateway + session and
 * rehydrated on connect (`loadTranscripts`). The chat overflow sheet
 * ("Session & connection") renders it read-only.
 *
 * This module holds the pure decisions so the section stays a thin reader:
 * order the already-held entries newest-first, cap the visible slice, and
 * label the collapsed toggle. Recording, keying, and reload-rehydrate live
 * in `transcript.ts` and the provider — nothing here writes.
 */
import type { CommandTranscriptEntry } from '@/lib/gateway/types';

/** How many of the newest entries the sheet shows. The store keeps 200. */
export const COMMAND_HISTORY_VISIBLE_LIMIT = 20;

/** Newest-first copy of the held entries. The held order is untouched. */
export function commandHistoryNewestFirst(
  entries: CommandTranscriptEntry[],
): CommandTranscriptEntry[] {
  return [...entries].sort((a, b) => b.createdAt - a.createdAt);
}

/** The recent slice the sheet renders, newest-first. */
export function commandHistoryVisible(
  entries: CommandTranscriptEntry[],
  limit: number = COMMAND_HISTORY_VISIBLE_LIMIT,
): CommandTranscriptEntry[] {
  return commandHistoryNewestFirst(entries).slice(0, limit);
}

/** Honest empty note — an empty store reads as "none yet", never blank. */
export function commandHistoryEmptyCopy(): string {
  return 'No slash commands run in this session yet.';
}

/** Collapsed-by-default toggle label. Count only when entries are held. */
export function commandHistoryToggleLabel(open: boolean, count: number): string {
  if (open) return 'Hide history';
  if (count === 0) return 'Command history';
  return `Command history (${count})`;
}

/** Row title: the recorded title, falling back to the raw slash input. */
export function commandHistoryRowTitle(entry: CommandTranscriptEntry): string {
  return entry.title || entry.input;
}

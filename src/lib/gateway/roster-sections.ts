// ─── The roster's two shelves: ready Bots, and the ones that need setup ───
//
// A Gate with two dozen Bots painted every one of them in roster order, so the
// rows that cannot route pushed the rows that can — and the group chats and
// "Add to your team" below them — off the first screen. The Bots needing setup
// are still one tap from their fix (`roster-tap.ts`), so they belong in the
// list, just not in the way: the ready Bots keep the Gate's order, and the
// others fold behind one row that expands in place.
//
// Pure so the split, the count and its wording are cases rather than pixels.

import type { RosterRow } from './bots';
import { botReportedRoutable } from './roster-tap';

export type RosterSections = {
  /** Direct chat and every Bot that can take work, in the Gate's order. */
  ready: RosterRow[];
  /** The Bots that cannot route yet, in the Gate's order. */
  unset: RosterRow[];
};

/**
 * Split the visible rows into the two shelves. Navigation rows (Direct chat)
 * always stay on the ready shelf — the way back never folds away — and any row
 * the Gate reports as unroutable goes behind the fold, whatever the reason.
 */
export function groupRosterRows(rows: readonly RosterRow[]): RosterSections {
  const ready: RosterRow[] = [];
  const unset: RosterRow[] = [];
  for (const row of rows) {
    if (row.kind === 'bot' && !botReportedRoutable(row.bot)) unset.push(row);
    else ready.push(row);
  }
  return { ready, unset };
}

/** The fold's one line, counted the way a person would say it. */
export function unsetBotsLabel(count: number): string {
  return count === 1 ? '1 Bot not set up' : `${count} Bots not set up`;
}

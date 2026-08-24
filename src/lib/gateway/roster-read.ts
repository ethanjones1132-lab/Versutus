import { buildRoster, type PublicBot, type RosterRow } from '@/lib/gateway/bots';

export type { PublicBot, RosterRow };

/** What one roster inventory read produced. */
export type RosterRead =
  | { ok: true; bots: PublicBot[] }
  | { ok: false };

/**
 * Fold a roster inventory read into the visible rows. Two failures are not
 * the same fact:
 *   - A failed FIRST read claims zero knowledge — navigation row only.
 *   - A failed RE-read (pull-to-refresh) keeps the last good rows: they were
 *     really on the host moments ago, and a network blip must not erase bots
 *     the operator was just looking at. The error line explains staleness.
 * Only a SUCCESSFUL read may clear or replace the list — an empty-but-ok
 * answer is the host telling the truth, and it must be believed.
 */
export function applyRosterRead(previousRows: RosterRow[], read: RosterRead): RosterRow[] {
  if (read.ok) return buildRoster(read.bots);
  return previousRows.some((row) => row.kind === 'bot') ? previousRows : [{ kind: 'configurable' }];
}

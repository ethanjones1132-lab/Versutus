import type { ActivityRun } from '@/lib/gateway/runs';

/** What a teammate is doing right now, as the drawer says it. */
export type TeamPresence = 'needs-you' | 'working';

/**
 * Each Bot's live state, from the runs this device holds: a Bot with a run
 * waiting on the operator "needs you" (that outranks working — it is the one
 * that asks for something); a Bot with a run in flight is "working". A Bot
 * with neither has no entry, and the drawer says nothing about it.
 */
export function teamPresence(runs: readonly ActivityRun[]): ReadonlyMap<string, TeamPresence> {
  const presence = new Map<string, TeamPresence>();
  for (const run of runs) {
    if (!run.botId) continue;
    if (run.status === 'waiting-approval') presence.set(run.botId, 'needs-you');
    else if (run.status === 'running' && presence.get(run.botId) !== 'needs-you') presence.set(run.botId, 'working');
  }
  return presence;
}

/**
 * Whether two presence maps say the same thing about the same teammates.
 *
 * `teamPresence` folds a NEW map on every call, so a run event that moves no
 * Bot between "working" and "needs you" still arrives as a different object —
 * and a surface that memoises its rows on the map cannot tell that from a real
 * change. This is the comparison that lets it keep the copy it already has.
 */
export function samePresence(
  a: ReadonlyMap<string, TeamPresence>,
  b: ReadonlyMap<string, TeamPresence>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [botId, state] of a) {
    if (b.get(botId) !== state) return false;
  }
  return true;
}

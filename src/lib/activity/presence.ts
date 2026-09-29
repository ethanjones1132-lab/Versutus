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

// ─── Activity run partition ───────────────────────────────────────
// One pass over the provider's run rows, answering the two lists the
// Activity list folds: the in-flight rows (a run still going, or still
// blocked on the operator's approval) above the settled ones. Pure —
// nothing here touches storage, a gateway, or a renderer, and the input
// list is never reordered or copied into itself.
//
// The predicate is written once here, and the glance, the drawer's presence
// and Home's digest all read it, so the surfaces cannot disagree about the
// same row: a row is finished exactly when it is not in flight.

import type { ActivityRun } from '@/lib/gateway/runs';

/**
 * A run restored from disk whose fate this device never learned — `unresolved`
 * with no finish of its own. The gateway may still be executing it, so it is
 * in flight until a settle re-poll gives it a real end; counting it as settled
 * is what let the glance call it working, Activity call it finished and the
 * drawer leave it out at the same time.
 */
export function inFlightAfterRestore(run: ActivityRun): boolean {
  return run.status === 'unresolved' && typeof run.finishedAt !== 'number';
}

/**
 * The one answer to "is this run still going": running, waiting on approval,
 * or a restored row whose fate was never learned. A `complete`, `failed`,
 * `cancelled` or truly finished `unresolved` row is not in flight.
 */
export function runIsInFlight(run: ActivityRun): boolean {
  return run.status === 'running' || run.status === 'waiting-approval' || inFlightAfterRestore(run);
}

/**
 * Partition the run rows once, in row order: every in-flight run into
 * `inFlightRuns`, every settled run into `finishedRuns`. Each row lands in
 * exactly one list, and both lists keep the input's order — the Activity
 * surface renders active above finished with rows newest-next, so order is
 * load-bearing and never a re-sort.
 */
export function partitionRunsByState(runs: readonly ActivityRun[]): {
  inFlightRuns: ActivityRun[];
  finishedRuns: ActivityRun[];
} {
  const inFlightRuns: ActivityRun[] = [];
  const finishedRuns: ActivityRun[] = [];
  for (const run of runs) {
    (runIsInFlight(run) ? inFlightRuns : finishedRuns).push(run);
  }
  return { inFlightRuns, finishedRuns };
}

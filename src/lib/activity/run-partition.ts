// ─── Activity run partition ───────────────────────────────────────
// One pass over the provider's run rows, answering the two lists the
// Activity list folds: the in-flight rows (a run still going, or still
// blocked on the operator's approval) above the settled ones. Pure —
// nothing here touches storage, a gateway, or a renderer, and the input
// list is never reordered or copied into itself.
//
// The predicate is the screen's own, written once here so the two arrays
// cannot disagree: a row is finished exactly when it is not in flight.

import type { ActivityRun } from '@/lib/gateway/runs';

/** A run this device still counts as going: running, or waiting on approval. */
export function runIsInFlight(run: ActivityRun): boolean {
  return run.status === 'running' || run.status === 'waiting-approval';
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

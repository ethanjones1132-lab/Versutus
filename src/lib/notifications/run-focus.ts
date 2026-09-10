// ─── A requested run focus ────────────────────────────────────────
// A notification tap is the producer: a run notice names the run it settled
// (`notifyRunComplete`), and the Activity list can be filtered to a different
// Bot at the moment the tap lands — the Scorecards tap leaves the tab's own
// filter set. A tap cannot show a run this device does not hold, so the request
// is not "select this run": it is "drop the filter", so the list is again the
// whole read the notice was drawn from. The id rides with the request because
// it is what makes two taps the same tap; no surface acts on it beyond that.
//
// Pure, so the fold is jest-pinnable and needs no renderer. The provider holds
// the pending request and the Activity tab applies it and clears it — the same
// shape as a requested chat surface (`@/lib/gateway/surface-request`).

/** The run a notification tap named. */
export type RunFocus = { runId: string };

/**
 * Fold a request into the pending slot. A request for the run already pending
 * returns that value unchanged — the tab's effect keys on it, and a fresh
 * object would re-apply a focus that is already applied.
 */
export function pendingRunFocus(pending: RunFocus | null, requested: RunFocus): RunFocus | null {
  if (pending && pending.runId === requested.runId) return pending;
  return requested;
}

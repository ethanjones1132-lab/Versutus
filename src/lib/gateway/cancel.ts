// ─── Server-side cancellation helpers ─────────────────────────────
//
// Pure decision logic for asking the gateway to stop work the user just
// cancelled locally. Keeps provider-side refs and side effects out of the
// testable core.

export type CancellableClient = {
  stopRun?(runId: string): Promise<void>;
};

/**
 * Whether a run id is a provisional entry the app minted before the gateway
 * accepted the run (`local-…` in gateway-provider runTask, re-keyed to the
 * real gateway id in onStarted). The gateway never saw these, so there is
 * nothing to stop or re-poll server-side.
 */
export function isLocalProvisionalRunId(runId: string): boolean {
  return runId.startsWith('local-');
}

/**
 * Ask the gateway to stop an agentic run that originated from a slash command.
 * Returns the best-effort promise so callers can fire-and-forget, or `undefined`
 * when there is nothing to cancel.
 *
 * The swallow here is deliberate and compensated: every caller fires only while
 * the run's own executeRun driver is still alive, and that driver's abort
 * branch re-asks via requestStop — whose failure lands on the activity card as
 * `unresolved` with the gateway's refusal explained, rather than vanishing.
 */
export function serverSideCancelForCommand(
  client: CancellableClient | null,
  runningRunId: string | null,
): Promise<void> | undefined {
  if (client?.stopRun && runningRunId && !isLocalProvisionalRunId(runningRunId)) {
    return client.stopRun(runningRunId).catch(() => undefined);
  }
  return undefined;
}

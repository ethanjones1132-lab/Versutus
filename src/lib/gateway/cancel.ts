// ─── Server-side cancellation helpers ─────────────────────────────
//
// Pure decision logic for asking the gateway to stop work the user just
// cancelled locally. Keeps provider-side refs and side effects out of the
// testable core.

export type CancellableClient = {
  stopRun?(runId: string): Promise<void>;
};

/**
 * Ask the gateway to stop an agentic run that originated from a slash command.
 * Returns the best-effort promise so callers can fire-and-forget, or `undefined`
 * when there is nothing to cancel.
 */
export function serverSideCancelForCommand(
  client: CancellableClient | null,
  runningRunId: string | null,
): Promise<void> | undefined {
  if (client?.stopRun && runningRunId && !runningRunId.startsWith('local-')) {
    return client.stopRun(runningRunId).catch(() => undefined);
  }
  return undefined;
}

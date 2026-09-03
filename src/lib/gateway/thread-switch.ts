// ─── Thread-row switch validation ────────────────────────────────────────
//
// Tapping a thread row in the thread sheet pinned the id and reloaded history
// with no read first (`selectSession` in `src/context/gateway-provider.tsx`),
// while `/session restore <id>` reads `session.restore` and switches the open
// thread only after it resolves (`src/lib/gateway/slash-commands.ts:1185`).
// A row for a session the gateway has deleted therefore moved local history
// first and failed at the history read after.
//
// So the tap validates the id through the same `session.restore` read before
// switching. The read is the existing protocol on both transports — the Gate
// dispatches it (`gate/core/capabilities/gateway-methods.mjs:236-237`) and a
// direct Hermes connection serves its REST twin
// (`GET /api/sessions/{sessionId}` at `src/lib/gateway/rpc-routes.ts:29`) —
// so no new endpoint, and direct Hermes keeps its REST read.
//
// Where `session.restore` is not dispatched at all (no request function, e.g.
// no connected client) the switch stays instant: today's behaviour, untouched.

/** The `session.restore` read behind the tap validation. */
export type ThreadSwitchRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** A validated tap: either the switch may proceed, or it must stay put. */
export type ThreadSwitchValidation = { ok: true } | { ok: false; error: string };

/**
 * The failure copy for a rejected validation. Deliberately the slash path's
 * own wording (`Session ${id} could not be restored: …`) so the tap and
 * `/session restore` name the same failure the same way.
 */
export function threadSwitchFailureText(sessionId: string, error: string): string {
  return `Session ${sessionId} could not be restored: ${error}`;
}

/**
 * Read `session.restore` ahead of the existing pin+reload. A resolved read
 * means the gateway still holds the session and the switch may proceed; a
 * rejection carries the failure so the caller can name it and keep the
 * current thread. No request function means the method is not dispatched on
 * this path — the switch proceeds instantly, exactly today's behaviour.
 */
export async function validateThreadSwitch(
  request: ThreadSwitchRequest | undefined,
  sessionId: string,
): Promise<ThreadSwitchValidation> {
  if (!request) return { ok: true };
  try {
    await request('session.restore', { sessionId });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

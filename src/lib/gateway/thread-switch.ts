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
//
// ─── What is allowed to refuse the tap ───────────────────────────────────
//
// Refusing on every failure is what the operator saw: a timeout, a 5xx, a host
// that was down, or — the case that started all of this — the Gate resolving
// the lookup against the wrong environment all answered the same red card, so a
// session that was perfectly healthy could not be opened. Only a DEFINITE miss
// blocks now: the gate says `unknown_session`, or the read failed with the one
// wording that means it. Everything else proceeds, because the history read
// that follows reports the real failure with the real thread in place — which is
// strictly more use than a refusal that says "could not be sure".

/** The `session.restore` read behind the tap validation. */
export type ThreadSwitchRequest = (
  method: string,
  params: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

/**
 * The scope the read is asked in, so the Gate reads this thread's own
 * environment. A Bot travels alone for the same reason it does everywhere else:
 * it names its own environment (`rpc-scope.ts`).
 */
export type ThreadSwitchScope = { backendId?: string; botId?: string };

/**
 * A validated tap: either the switch may proceed, or it must stay put.
 *
 * `refreshList` marks the refusal as a definite miss, which is also the signal
 * that the row the operator just tapped is stale: the gateway has said that
 * session is gone, so the list is re-read once and stops offering it. It is
 * optional because a refusal from a sibling read (`openSessionById`) is not
 * about a row anybody listed.
 */
export type ThreadSwitchValidation =
  | { ok: true }
  | { ok: false; error: string; refreshList?: true };

/**
 * How long the validation may take. Long enough for a cold Gate to ask a slow
 * host about one id, short enough that a tap never feels broken: a read still
 * running at the bound is not evidence of anything, so it lets the switch
 * proceed and the history read reports whatever the host says.
 */
export const THREAD_SWITCH_BOUND_MS = 8000;

/** The gate's own code for "that session is not here". */
const UNKNOWN_SESSION = 'unknown_session';

/**
 * The failure copy for a rejected validation. Deliberately the slash path's
 * own wording (`Session ${id} could not be restored: …`) so the tap and
 * `/session restore` name the same failure the same way.
 */
export function threadSwitchFailureText(sessionId: string, error: string): string {
  return `Session ${sessionId} could not be restored: ${error}`;
}

/** The machine-readable code a refusal carries, when it carries one. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && code ? code : undefined;
}

/**
 * Whether this failure PROVES the session is gone.
 *
 * The code is the gate's own word for it, so it is trusted wherever it comes
 * from. The message is only trusted when the read was scoped: an unscoped read
 * that cannot find a session has only proved it asked somewhere that does not
 * hold it, which is exactly the failure this whole path exists to survive.
 */
function isDefiniteMiss(error: unknown, scoped: boolean): boolean {
  if (codeOf(error) === UNKNOWN_SESSION) return true;
  const message = error instanceof Error ? error.message : String(error);
  return scoped && /session not found/i.test(message);
}

/** Whether a request named an environment or a Bot. */
function isScoped(scope: ThreadSwitchScope | undefined): boolean {
  return Boolean(scope?.backendId || scope?.botId);
}

/** The params this validation asks `session.restore` with. */
function restoreParams(sessionId: string, scope: ThreadSwitchScope | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = { sessionId };
  if (scope?.botId) params.bot = scope.botId;
  else if (scope?.backendId) params.backendId = scope.backendId;
  return params;
}

/**
 * Read `session.restore` ahead of the existing pin+reload, bounded.
 *
 * A resolved read, and any failure that does not prove absence, let the switch
 * proceed. A definite miss blocks and carries the failure so the caller can
 * name it, plus `refreshList` so the stale row goes away with it. No request
 * function means the method is not dispatched on this path and the switch
 * proceeds instantly, exactly today's behaviour.
 */
export async function validateThreadSwitch(
  request: ThreadSwitchRequest | undefined,
  sessionId: string,
  scope?: ThreadSwitchScope,
  boundMs = THREAD_SWITCH_BOUND_MS,
): Promise<ThreadSwitchValidation> {
  if (!request) return { ok: true };
  const scoped = isScoped(scope);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), boundMs);
  });
  try {
    // A request that throws before it returns a promise is a failed read like any
    // other, not an exception out of the tap. The bound travels WITH the read, so
    // the read stops at the same moment the tap does: a request that kept running
    // on the Gate for the transport's own 30 s after the switch had already
    // proceeded is a catalogue read with nobody waiting for the answer.
    const read = Promise.resolve().then(() =>
      request('session.restore', restoreParams(sessionId, scope), { timeoutMs: boundMs }),
    );
    const outcome = await Promise.race([
      read.then(() => null, (error: unknown) => error),
      bound,
    ]);
    if (outcome === null) return { ok: true };
    if (outcome === 'timeout') return { ok: true };
    return isDefiniteMiss(outcome, scoped)
      ? { ok: false, error: outcome instanceof Error ? outcome.message : String(outcome), refreshList: true }
      : { ok: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

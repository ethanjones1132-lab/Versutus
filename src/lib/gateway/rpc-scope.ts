// ─── Scope on the RPC route ──────────────────────────────────────
//
// The REST helpers here have always carried the thread's scope: `withScope`
// (manifest-client.ts) appends `backendId=` and `bot=` to every conversation
// and run route. The RPC route had no equivalent — `rpcRequest` posts
// `{ method, params }` exactly as the caller wrote it — so the Gate had to
// guess which attached environment a session call meant. It guessed "the first
// one that can serve listSessions", which is `claude-local` on a typical Gate,
// and `params.bot` was never read at all. Tapping a thread created in the app
// therefore asked Claude Code's catalogue for a Hermes session id and answered
// `Session not found: <id>` for a session the operator was looking at. Same
// class as the 2026-09-03 "REST helpers carry Bot scope, RPC does not".
//
// So the scope is merged here, in the client, where the REST twin puts it: a
// caller that names its own scope keeps it, and a method that reads no backend
// is left byte-for-byte as it was.

/**
 * Catalogue methods that read a backend, so the Gate has to know which one.
 *
 * `tools.list` and `skills.list` are deliberately not here: only the Hermes
 * backend implements them, and the Gate answers an unscoped call from the first
 * backend that can. Pinning them to the thread's environment turns every
 * Claude Code / Codex / OpenCode thread's `/tools`, `/skills` and Toolsets panel
 * into `This gateway's backend does not implement listToolsets`.
 */
const CATALOGUE_METHODS = new Set(['models.list']);

/**
 * Whether this method reads an attached backend.
 *
 * The session family is a rule, not a list: every `session.*` / `sessions.*`
 * read is about one thread, and a new one added to the Gate's dispatcher must
 * not be the next one that forgets. Cron, jobs and Bots are deliberately NOT
 * here — they are the Gate's own surfaces rather than this thread's, and
 * pinning them to a Claude-Code selection would turn a working roster into
 * `This backend does not implement bots`.
 */
export function readsABackend(method: string): boolean {
  return method.startsWith('session.') || method.startsWith('sessions.') || CATALOGUE_METHODS.has(method);
}

/** The scope a client currently holds, in the names the Gate reads. */
export type RpcScope = { backendId?: string; botId?: string };

/**
 * `params` with this client's scope folded in, for the methods that need it.
 *
 * A caller that passed its own `backendId` or `bot` keeps it whole — the whole
 * scope, not half of it, because mixing a caller's environment with the
 * client's Bot is how a scoped read ends up somewhere neither asked for.
 *
 * When both are held, the Bot travels alone: a Bot IS a Hermes profile and
 * names its own environment, so a pinned environment sent alongside it is a
 * deliberate override the Gate would honour (`resolveConversationScope`) and
 * answer 501 from Claude Code. `withScope` makes the same choice for the REST
 * routes.
 */
export function rpcParamsWithScope(
  method: string,
  params: Record<string, unknown>,
  scope: RpcScope,
): Record<string, unknown> {
  if (!readsABackend(method)) return params;
  if (params.backendId !== undefined || params.bot !== undefined) return { ...params };
  if (scope.botId) return { ...params, bot: scope.botId };
  if (scope.backendId) return { ...params, backendId: scope.backendId };
  return params;
}

/**
 * An RPC refusal carrying the Gate's own machine-readable code.
 *
 * The code is what lets a caller act on one refusal and merely report another:
 * a thread tap refuses on `unknown_session` and lets a timeout, a 5xx or an
 * unreachable host through to the read that follows it.
 */
export class GatewayRpcError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'GatewayRpcError';
  }
}

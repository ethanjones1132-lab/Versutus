import { GatewayHttpError, isConnectionError } from '@/lib/gateway/errors';

/**
 * Bounded retry for GET session-list reads. HermesGatewayClient and
 * ManifestClient both call this helper so the policy cannot drift.
 *
 * GET only: callers pass a GET. Never wrap createSession or any POST.
 *
 * Per-attempt ceiling for a SMALL GET /sessions. The list answers in ~80ms
 * when the host is up; 8s covers a Tailscale-cold GET without sitting on the
 * transport's 30s default.
 *
 * A large read is a different question. The Gate's own ceiling for a
 * session-list read is 30s and `limit=200` measures ~11s on the operator's
 * host, so the 8s ceiling aborted every attempt of a legitimate large read
 * while the abandoned attempt kept running on the Gate — the read the client
 * gave up on still held state.db. Above the threshold the per-attempt budget
 * matches the Gate's ceiling so a slow read can actually finish.
 */
export const GET_SESSIONS_ATTEMPT_TIMEOUT_MS = 8_000;
export const GET_SESSIONS_LARGE_ATTEMPT_TIMEOUT_MS = 30_000;
/** Above this limit a read is a bulk read, not a picker refresh. */
export const GET_SESSIONS_LARGE_LIMIT = 50;
export const GET_SESSIONS_MAX_RETRIES = 2;
export const GET_SESSIONS_RETRY_BACKOFF_MS = [500, 1_500] as const;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableSessionListError(error: unknown): boolean {
  if (error instanceof GatewayHttpError) return error.status >= 500 && error.status <= 599;
  return isConnectionError(error);
}

/**
 * A request that ran out of its per-attempt budget (HttpTransport's abort
 * timer). A 5xx or a refused connection is a blip the next attempt may fix; a
 * timeout is the read still being slow, and the attempt we abandoned is still
 * running on the Gate — so the budget for retrying one is deliberately lower.
 */
function isAttemptTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\btimed out\b|\btimeout\b/i.test(message);
}

/**
 * Run `getOnce` with the session-list retry policy. `getOnce` receives the
 * per-attempt timeout so callers cannot forget the ceiling. Pass `options.limit`
 * when the caller knows how many rows it asked for: a large read needs the
 * Gate-scale budget and must not be retried after a timeout.
 */
export async function withGetSessionsRetry<T>(
  getOnce: (timeoutMs: number) => Promise<T>,
  options: { limit?: number } = {},
): Promise<T> {
  const large = typeof options.limit === 'number' && options.limit > GET_SESSIONS_LARGE_LIMIT;
  const attemptTimeoutMs = large
    ? GET_SESSIONS_LARGE_ATTEMPT_TIMEOUT_MS
    : GET_SESSIONS_ATTEMPT_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    try {
      return await getOnce(attemptTimeoutMs);
    } catch (error) {
      if (!isRetriableSessionListError(error)) throw error;
      // A timeout gets one more chance on a small read and none on a large
      // one; a 5xx or a dead radio keeps the full ladder.
      const maxRetries = isAttemptTimeout(error)
        ? large
          ? 0
          : 1
        : GET_SESSIONS_MAX_RETRIES;
      if (attempt >= maxRetries) throw error;
      const backoffMs = GET_SESSIONS_RETRY_BACKOFF_MS[attempt];
      if (typeof backoffMs !== 'number') throw error;
      await waitMs(backoffMs);
      attempt += 1;
    }
  }
}

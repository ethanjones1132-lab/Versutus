import { GatewayHttpError, isConnectionError } from '@/lib/gateway/errors';

/**
 * Bounded retry for GET session-list reads. HermesGatewayClient and
 * ManifestClient both call this helper so the policy cannot drift.
 *
 * GET only: callers pass a GET. Never wrap createSession or any POST.
 *
 * Per-attempt ceiling for GET /sessions. The list answers in ~80ms when
 * the host is up; 8s covers a Tailscale-cold GET without sitting on the
 * transport's 30s default.
 *
 * Two retries, 500ms then 1500ms backoff, only on network errors and 5xx.
 * 404 is never retried — it is a dialect/capability signal, not a blip
 * (Hermes uses it to fall back to /api/sessions; ManifestClient surfaces
 * it as a missing route). A "does not advertise session management" throw
 * happens before this helper is called, so it stays immediate.
 *
 * Worst case on a hung gateway: 3 × 8s + 0.5s + 1.5s = 26s — under the 30s
 * single-shot default, so a dead host is not slower than today.
 */
export const GET_SESSIONS_ATTEMPT_TIMEOUT_MS = 8_000;
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
 * Run `getOnce` with the session-list retry policy. `getOnce` receives the
 * per-attempt timeout so callers cannot forget the 8s ceiling.
 */
export async function withGetSessionsRetry<T>(
  getOnce: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await getOnce(GET_SESSIONS_ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      if (!isRetriableSessionListError(error) || attempt >= GET_SESSIONS_MAX_RETRIES) {
        throw error;
      }
      const backoffMs = GET_SESSIONS_RETRY_BACKOFF_MS[attempt];
      if (typeof backoffMs !== 'number') throw error;
      await waitMs(backoffMs);
      attempt += 1;
    }
  }
}

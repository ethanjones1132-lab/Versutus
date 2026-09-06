import type { AuthAttempt, BeginAuthAnswer } from '@/lib/gateway/provider-client';

export type OAuthBeginDisplay = {
  attemptId: string;
  authorizationUrl: string;
};

/** How often the progress sheet re-reads a live OAuth attempt. */
export const OAUTH_ATTEMPT_POLL_MS = 3000;

/**
 * The begin answer names the browser URL the operator must visit. A Gate that
 * predates the URL field (or an answer with only whitespace) leaves the phone
 * with nothing to open, so this resolves to null and the caller keeps the
 * fire-and-forget progress copy instead of rendering an empty link.
 */
export function resolveOAuthBeginDisplay(
  answer: BeginAuthAnswer | null | undefined,
): OAuthBeginDisplay | null {
  const attemptId = (answer?.attemptId ?? '').trim();
  const authorizationUrl = (answer?.authorizationUrl ?? '').trim();
  if (!attemptId || !authorizationUrl) return null;
  return { attemptId, authorizationUrl };
}

/**
 * True once the attempt's budget has run out. A non-numeric `expiresAt` never
 * reads as expired — a malformed read must keep the sheet waiting, not report
 * an expiry the Gate never declared.
 */
export function oauthAttemptExpired(
  attempt: AuthAttempt | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (typeof attempt?.expiresAt !== 'number') return false;
  return attempt.expiresAt <= nowMs;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * The Gate deletes an attempt once the browser authorization is consumed, so
 * `unknown attempt` on an id the begin answer just named means the attempt is
 * gone — finished, not broken. The caller reloads providers and stops polling.
 */
export function isUnknownOAuthAttempt(caught: unknown): boolean {
  return errorMessage(caught).includes('unknown attempt');
}

/**
 * A gateway that cannot answer the attempt read fails the poll, not the
 * sheet: a Hermes-kind host answers `<method> is not supported by this
 * gateway` (client.ts `rpcRequest`), a Gate without the RPC surface answers
 * `Unknown method` (gate/core/server.mjs), and a manifest client with no
 * capabilities RPC answers `<method> is not supported by <kind>`
 * (manifest-client.ts `rpcRequest`). Polling any of them forever would hold
 * the sheet hostage, so the caller stops polling and keeps the
 * fire-and-forget progress copy.
 */
export function isOAuthAttemptPollUnsupported(caught: unknown): boolean {
  const message = errorMessage(caught);
  return (
    message.includes('Unknown method') ||
    message.includes('unknown_method') ||
    message.includes('is not supported by')
  );
}

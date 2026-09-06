import type { BeginAuthAnswer } from '@/lib/gateway/provider-client';

export type OAuthBeginDisplay = {
  attemptId: string;
  authorizationUrl: string;
};

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

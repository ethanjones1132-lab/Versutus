/**
 * Which routes stay reachable while the app still needs onboarding.
 *
 * `/onboarding` is the classic first-run screen. `/gateway/add` is part of
 * onboarding now: a fresh install that opens a `versutus://add?url=…` deep
 * link must land on the prefilled add sheet instead of being bounced to the
 * generic screen that knows nothing about the link. Every other surface still
 * redirects until a gateway exists.
 */
export function isOnboardingExemptRoute(segments: readonly string[]): boolean {
  const root = segments[0] ?? '';
  if (root === 'onboarding') return true;
  return root === 'gateway' && segments[1] === 'add';
}

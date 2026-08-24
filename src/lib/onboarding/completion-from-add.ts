import { friendlyPcName, normalizePcAddress } from '@/lib/gateway/candidates';

import type { AppSettings } from '@/lib/settings/app-settings';

/**
 * Completing any gateway add completes onboarding. Onboarding used to be its
 * own URL+token flow (`setupFromPcAddress`) that marked itself complete, while
 * the manual/deep-link add flow saved a profile yet left `needsOnboarding`
 * set — so a first-run add bounced straight back to the generic onboarding
 * screen. The add flow IS the onboarding flow now.
 *
 * The derived `tailscaleHost` feeds future auto-connect candidate probing
 * (buildGatewayCandidates), exactly like the value the old onboarding screen
 * saved. It is only filled when the app has no host yet — the first machine
 * you deliberately add wins, later adds never churn it.
 */
export function onboardingCompletionForAddedGateway(
  url: string,
  current: Pick<AppSettings, 'tailscaleHost'>,
): Partial<AppSettings> {
  const patch: Partial<AppSettings> = { onboardingComplete: true };
  if (current.tailscaleHost && current.tailscaleHost.trim()) return patch;

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  host = normalizePcAddress(host);
  // Dot-less hosts ("localhost") are machine-local noise, never a probe target.
  if (!host || !host.includes('.')) return patch;

  // pcName is a user-facing title (home card, chat header) — derive it only
  // for name-like hosts so an IP add does not title the app "192".
  const nameLike = /[a-z]/i.test(host);
  return { ...patch, tailscaleHost: host, ...(nameLike ? { pcName: friendlyPcName(host) } : {}) };
}

import type { AppSettings } from '@/lib/settings/app-settings';

/** Whether first-run setup is still needed before a gateway has been saved. */
export function needsGatewayOnboarding({
  settings,
  savedGatewayCount,
}: {
  settings: Pick<AppSettings, 'onboardingComplete' | 'tailscaleHost' | 'manualSetupPending'>;
  savedGatewayCount: number;
}): boolean {
  return settings.manualSetupPending === true || (!settings.onboardingComplete && savedGatewayCount === 0);
}

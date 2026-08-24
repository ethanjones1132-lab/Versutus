import { isOnboardingExemptRoute } from '@/lib/onboarding/route-guard';

describe('onboarding route exemption', () => {
  test('the generic first-run screen stays exempt', () => {
    expect(isOnboardingExemptRoute(['onboarding'])).toBe(true);
  });

  test('the add flow is part of onboarding — deep links survive the first-run redirect', () => {
    expect(isOnboardingExemptRoute(['gateway', 'add'])).toBe(true);
  });

  test('every other surface still bounces until a gateway exists', () => {
    expect(isOnboardingExemptRoute(['gateway'])).toBe(false);
    expect(isOnboardingExemptRoute(['gateway', 'settings'])).toBe(false);
    expect(isOnboardingExemptRoute(['gateway', 'setup'])).toBe(false);
    expect(isOnboardingExemptRoute(['(tabs)', 'index'])).toBe(false);
    expect(isOnboardingExemptRoute([])).toBe(false);
  });
});

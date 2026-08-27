import { onboardingKeyboardBehavior } from '@/lib/onboarding/keyboard-behavior';

describe('onboardingKeyboardBehavior', () => {
  test('iOS uses padding (lifts ScrollView above IME)', () => {
    expect(onboardingKeyboardBehavior('ios')).toBe('padding');
  });

  test('Android uses undefined (ScrollView pans, no height squeeze)', () => {
    expect(onboardingKeyboardBehavior('android')).toBeUndefined();
  });

  test('web uses undefined (no KAV needed)', () => {
    expect(onboardingKeyboardBehavior('web')).toBeUndefined();
  });

  test('unknown platform defaults to undefined', () => {
    expect(onboardingKeyboardBehavior('windows')).toBeUndefined();
    expect(onboardingKeyboardBehavior('')).toBeUndefined();
  });
});

/**
 * KeyboardAvoidingView behavior for the onboarding screen.
 *
 * iOS: 'padding' lifts the ScrollView so the form stays above the IME.
 * Android: undefined — 'height' shrinks the whole Screen and squeezes the
 * form behind the IME on short phones (640px + gesture nav). The ScrollView
 * already has keyboardShouldPersistTaps + flexGrow centering, so it pans
 * without a KAV behavior on Android. This matches chat-composer.tsx which
 * uses undefined on Android and relies on ComposerKeyboardLift.
 */
export function onboardingKeyboardBehavior(platform: string): 'padding' | undefined {
  return platform === 'ios' ? 'padding' : undefined;
}

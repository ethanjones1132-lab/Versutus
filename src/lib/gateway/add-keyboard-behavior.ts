/**
 * KeyboardAvoidingView behavior for the gateway Add screen.
 *
 * iOS: 'padding' lifts the ScrollView so the form stays above the IME.
 * Android: undefined — 'height' shrinks the whole Screen and squeezes the
 * six-field form behind the IME on short phones (640px + gesture nav).
 * The ScrollView already has keyboardShouldPersistTaps + flexGrow panning,
 * so it pans without a KAV behavior on Android. Mirrors
 * onboardingKeyboardBehavior and terminalKeyboardBehavior.
 */
export function gatewayAddKeyboardBehavior(platform: string): 'padding' | undefined {
  return platform === 'ios' ? 'padding' : undefined;
}

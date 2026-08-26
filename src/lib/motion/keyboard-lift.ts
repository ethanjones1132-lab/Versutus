/**
 * IME lift for a composer already inside a bottom-safe Screen.
 *
 * MUST stay a worklet. ComposerKeyboardLift calls this from inside
 * `useAnimatedStyle`, so it runs on the UI thread — and because the call sits
 * behind `Platform.OS === 'android' ? … : 0`, only Android ever reaches it.
 * Without this directive the Babel plugin cannot hoist the function to the UI
 * runtime; it is captured into the worklet's `__closure` as an ordinary JS
 * function, and invoking one of those from the UI thread takes the whole
 * process down. That is the "Versutus keeps stopping" force-close that hit the
 * instant any chat or Bot was opened (the composer is the only thing that
 * mounts there and nowhere else), while iOS and web were untouched.
 */
export function composerKeyboardLift(keyboardHeight: number, bottomInset: number): number {
  'worklet';
  if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) return 0;
  const inset = Number.isFinite(bottomInset) && bottomInset > 0 ? bottomInset : 0;
  return Math.max(0, keyboardHeight - inset);
}

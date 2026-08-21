/** IME lift for a composer already inside a bottom-safe Screen. */
export function composerKeyboardLift(keyboardHeight: number, bottomInset: number): number {
  if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) return 0;
  const inset = Number.isFinite(bottomInset) && bottomInset > 0 ? bottomInset : 0;
  return Math.max(0, keyboardHeight - inset);
}

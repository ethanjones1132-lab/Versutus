// Composer dock bottom clearance — keeps the sticky Send row above the
// Android system bar when the IME is hidden (the transcript tail fix at
// `chatTranscriptContentPaddingBottom` only pads the scroll, not the dock).
// ComposerKeyboardLift now returns `insetBottom` when keyboardHeight is 0 on
// Android, so the dock's 8px base plus the lift clears gesture/3-button bar.
export const COMPOSER_DOCK_BASE_PADDING = 8;

export function composerDockPaddingBottom(input: {
  platform: string;
  insetBottom: number;
  keyboardHeight?: number;
  base?: number;
}): number {
  const base = input.base ?? COMPOSER_DOCK_BASE_PADDING;
  const safeBase = Number.isFinite(base) && base >= 0 ? base : COMPOSER_DOCK_BASE_PADDING;
  if (input.platform !== 'android') return safeBase;
  const inset = Number.isFinite(input.insetBottom) && input.insetBottom > 0 ? input.insetBottom : 0;
  const keyboardHeight = input.keyboardHeight ?? 0;
  const hasKeyboard = Number.isFinite(keyboardHeight) && keyboardHeight > 0;
  const lift = hasKeyboard ? Math.max(0, keyboardHeight - inset) : inset;
  return safeBase + lift;
}

export function composerKeyboardLiftForTest(keyboardHeight: number, bottomInset: number): number {
  const inset = Number.isFinite(bottomInset) && bottomInset > 0 ? bottomInset : 0;
  if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) return inset;
  return Math.max(0, keyboardHeight - inset);
}

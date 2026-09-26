/**
 * Safe-area edges for a Screen under the side-drawer IA (zero bottom tabs).
 *
 * `hasDock` means the screen owns a bottom chrome of its own (composer,
 * sticky dock). Those screens need Screen's bottom edge so the chrome clears
 * the home indicator. Screens without a dock also take the bottom edge now
 * that NativeTabs no longer owns it — the drawer does not inset content.
 *
 * `hasDock: false` is retained for callers that still opt out of bottom
 * padding (e.g. a nested surface that pads itself), but the default for
 * top-level Chat / Activity / Tools / Gate screens is `hasDock: true`.
 */

export type ScreenEdge = 'top' | 'bottom';

export function screenEdgesFor(input: {
  platform: string;
  hasDock: boolean;
}): ScreenEdge[] {
  if (input.hasDock) return ['top', 'bottom'];
  if (input.platform === 'ios' || input.platform === 'android') return ['top'];
  return ['top', 'bottom'];
}

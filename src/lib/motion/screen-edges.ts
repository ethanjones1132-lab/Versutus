/**
 * Safe-area edges for a tab Screen sitting inside Expo 57 NativeTabs.
 *
 * NativeTabs already owns the bottom inset: Android wraps tab content in a
 * SafeAreaView and applies the bottom edge; iOS enables automatic
 * content-inset adjustment on the first nested scroll view. Home and Activity
 * are those ScrollViews, so a Screen that also pads `bottom` stacks a second
 * tab-bar-height of empty space.
 *
 * Chat and Terminal keep a composer outside the list. On iOS that composer
 * still needs Screen's bottom edge. On Android the composer stays padded too:
 * `composerKeyboardLift` subtracts `insets.bottom`, so dropping the edge
 * without changing the lift puts the composer under the IME.
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

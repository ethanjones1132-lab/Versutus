// Terminal RPC ScrollView bottom padding — keeps the last command grid row
// and summary above the Android system bar when Screen is inside NativeTabs.
// Mirrors chatTranscriptContentPaddingBottom/tabContentPaddingBottom: base
// Spacing.four (16) + insetBottom on Android, base only on iOS/web.
// Values are literals to avoid importing tokens in jest (reanimated).
export const TERMINAL_RPC_BASE_PADDING = 16;

export function terminalRpcContentPaddingBottom(input: {
  platform: string;
  insetBottom: number;
  base?: number;
}): number {
  const base = input.base ?? TERMINAL_RPC_BASE_PADDING;
  const safeBase = Number.isFinite(base) && base >= 0 ? base : TERMINAL_RPC_BASE_PADDING;
  if (input.platform !== 'android') return safeBase;
  const inset = Number.isFinite(input.insetBottom) && input.insetBottom > 0 ? input.insetBottom : 0;
  return safeBase + inset;
}

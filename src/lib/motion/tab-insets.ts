// Tab ScrollView bottom padding — keeps the last card/row above the
// Android system bar when Screen no longer pads `bottom` (see
// `screenEdgesFor` which returns `['top']` on Android inside NativeTabs).
// Home and Activity use Spacing.four (24), Roster uses Spacing.five (32).
// Values are literals to avoid importing @/constants/tokens in jest
// (that module pulls react-native-reanimated which needs worklets init).

export const TAB_HOME_BASE_PADDING = 24;
export const TAB_ROSTER_BASE_PADDING = 32;

export function tabContentPaddingBottom(input: {
  platform: string;
  insetBottom: number;
  base?: number;
}): number {
  const base = input.base ?? TAB_HOME_BASE_PADDING;
  const safeBase = Number.isFinite(base) && base >= 0 ? base : TAB_HOME_BASE_PADDING;
  if (input.platform !== 'android') return safeBase;
  const inset = Number.isFinite(input.insetBottom) && input.insetBottom > 0 ? input.insetBottom : 0;
  return safeBase + inset;
}

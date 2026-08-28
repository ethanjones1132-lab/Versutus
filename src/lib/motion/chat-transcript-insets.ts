// Chat transcript bottom padding — keeps the last bubble above the
// Android system bar when Screen no longer pads `bottom` (see
// `screenEdgesFor` which returns `['top']` on Android inside NativeTabs).
// The FlatList is a sibling above ChatComposer, so the content needs its
// own tail padding equal to the base gap plus the bottom inset on Android.
export const CHAT_TRANSCRIPT_BASE_PADDING = 8;

export function chatTranscriptContentPaddingBottom(input: {
  platform: string;
  insetBottom: number;
  base?: number;
}): number {
  const base = input.base ?? CHAT_TRANSCRIPT_BASE_PADDING;
  const safeBase = Number.isFinite(base) && base >= 0 ? base : CHAT_TRANSCRIPT_BASE_PADDING;
  if (input.platform !== 'android') return safeBase;
  const inset = Number.isFinite(input.insetBottom) && input.insetBottom > 0 ? input.insetBottom : 0;
  return safeBase + inset;
}

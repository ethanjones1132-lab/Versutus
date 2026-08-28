// Chat jump-to-latest pill bottom offset — keeps the pill above the
// Android system bar when Screen no longer pads `bottom` (see
// `screenEdgesFor` which returns `['top']` on Android inside NativeTabs).
// The pill is absolutely positioned over the FlatList, so its `bottom`
// needs the base gap plus the bottom inset on Android.
export const CHAT_JUMP_BASE_BOTTOM = 8;

export function chatJumpBottom(input: {
  platform: string;
  insetBottom: number;
  base?: number;
}): number {
  const base = input.base ?? CHAT_JUMP_BASE_BOTTOM;
  const safeBase = Number.isFinite(base) && base >= 0 ? base : CHAT_JUMP_BASE_BOTTOM;
  if (input.platform !== 'android') return safeBase;
  const inset = Number.isFinite(input.insetBottom) && input.insetBottom > 0 ? input.insetBottom : 0;
  return safeBase + inset;
}

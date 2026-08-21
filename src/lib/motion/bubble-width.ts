const MONOGRAM = 26;
/** Matches Spacing.two — kept numeric so tests do not load Reanimated via tokens. */
const ROW_GAP = 8;
const MIN_BUBBLE = 120;

export function bubbleMaxWidth(windowWidth: number, hasMonogram: boolean): number {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return MIN_BUBBLE;
  const cap = Math.round(windowWidth * 0.85);
  const gutter = hasMonogram ? MONOGRAM + ROW_GAP : 0;
  return Math.max(MIN_BUBBLE, cap - gutter);
}

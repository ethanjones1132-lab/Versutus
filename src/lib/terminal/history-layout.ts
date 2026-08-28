export const TERMINAL_HISTORY_CHIP_MAX_WIDTH = 160;
export const TERMINAL_HISTORY_CHIP_GAP = 8; // Spacing.two
export const TERMINAL_HISTORY_HORIZONTAL_PADDING = 48; // Spacing.four * 2
export const TERMINAL_HISTORY_VISIBLE_COUNT = 3;

/**
 * Whether the history chip row overflows a given container width
 * and therefore needs a horizontal ScrollView on a phone.
 */
export function terminalHistoryNeedsScroll(containerWidth: number, chipCount = TERMINAL_HISTORY_VISIBLE_COUNT): boolean {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return false;
  if (!Number.isFinite(chipCount) || chipCount <= 0) return false;
  const needed =
    chipCount * TERMINAL_HISTORY_CHIP_MAX_WIDTH +
    Math.max(0, chipCount - 1) * TERMINAL_HISTORY_CHIP_GAP +
    TERMINAL_HISTORY_HORIZONTAL_PADDING;
  return needed > containerWidth;
}

/**
 * After wrapping in a horizontal ScrollView the row is always
 * reachable regardless of container width — overflow is resolved
 * by scrolling.
 */
export function terminalHistoryIsScrollable(): boolean {
  return true;
}

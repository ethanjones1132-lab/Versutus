// ─── How tall a sheet is allowed to get ───────────────────────────
//
// A sheet with no ceiling grows to whatever its children need. Anchored to the
// bottom of the screen, that overflow goes UPWARD — off the top — taking the
// eyebrow, the title and any action in the header with it. Reported 2026-08-25
// on the session picker: ~40 sessions made "New session" unreachable, and the
// list ran under the navigation bar at the same time.
//
// So the ceiling is the window minus the system insets minus the sheet's own
// margins. Bounding it is also what lets an inner FlatList scroll at all: a
// list inside an unbounded parent renders every row instead of scrolling.

/**
 * The two vertical gaps a sheet reserves, by anchor position:
 *
 * - `inner` is the real margin on the anchored edge — the one BaseSheet applies
 *   as marginBottom (bottom sheets) or marginTop (top sheets).
 * - `outer` is the breathing gap left at the FAR edge, so a full-height sheet
 *   stops short of the opposite side instead of butting against it.
 *
 * Values are Spacing.four (24) and Spacing.two (8) from the token scale,
 * restated as plain numbers so this module stays free of the token barrel —
 * that barrel pulls in Reanimated and cannot load in a bare unit test.
 * BaseSheet imports `inner` from here rather than re-declaring it, so the
 * ceiling and the actual margin cannot drift apart.
 */
export const SHEET_MARGIN = {
  bottom: { outer: 24, inner: 24 },
  top: { outer: 8, inner: 8 },
} as const;

/**
 * The tallest a sheet may be without any part of it leaving the screen.
 *
 * Never returns more than the space actually available, and never returns a
 * uselessly small number on a bad measurement — a zero or missing window
 * height means "not measured yet", and clamping to a floor keeps the sheet
 * usable rather than collapsing it to nothing.
 */
export function sheetMaxHeight(input: {
  windowHeight: number;
  insetTop?: number;
  insetBottom?: number;
  position?: 'top' | 'bottom';
  /** Smallest height worth rendering; below this the ceiling is ignored. */
  minimum?: number;
}): number {
  const { windowHeight, insetTop = 0, insetBottom = 0, position = 'bottom', minimum = 240 } = input;
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return minimum;

  const margin = SHEET_MARGIN[position];
  const available =
    windowHeight - Math.max(0, insetTop) - Math.max(0, insetBottom) - margin.outer - margin.inner;

  return Math.max(minimum, Math.round(available));
}

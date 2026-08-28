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

/** Extra IME lift: keyboard minus the inset already in the anchored-edge margin. */
function sheetImeExtraLift(
  position: 'top' | 'bottom',
  inset: number,
  keyboardHeight: number,
): number {
  if (position === 'top') return 0;
  const safeInset = Number.isFinite(inset) && inset > 0 ? inset : 0;
  if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) return 0;
  return Math.max(0, keyboardHeight - safeInset);
}

/**
 * Margin on the anchored edge, including IME lift for a bottom sheet.
 *
 * Extra lift is keyboard minus the inset already in this margin — the same
 * subtract-inset shape as `composerKeyboardLift`. A top-anchored sheet ignores
 * the keyboard.
 */
export function sheetAnchoredEdgeMargin(input: {
  position: 'top' | 'bottom';
  inset: number;
  keyboardHeight?: number;
}): number {
  const { position, inset, keyboardHeight = 0 } = input;
  const inner = SHEET_MARGIN[position].inner;
  const safeInset = Number.isFinite(inset) && inset > 0 ? inset : 0;
  return inner + safeInset + sheetImeExtraLift(position, safeInset, keyboardHeight);
}

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
  /** IME height. Shrinks a bottom sheet by the extra lift; ignored at the top. */
  keyboardHeight?: number;
}): number {
  const {
    windowHeight,
    insetTop = 0,
    insetBottom = 0,
    position = 'bottom',
    minimum = 240,
    keyboardHeight = 0,
  } = input;
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return minimum;

  const margin = SHEET_MARGIN[position];
  const extraLift = sheetImeExtraLift(position, insetBottom, keyboardHeight);
  const available =
    windowHeight -
    Math.max(0, insetTop) -
    Math.max(0, insetBottom) -
    margin.outer -
    margin.inner -
    extraLift;

  return Math.max(minimum, Math.round(available));
}

/** Extra bottom padding inside the sheet so a 42px gesture bar cannot clip the Close hitSlop. */
export function sheetContentPaddingBottom(input: {
  position: 'top' | 'bottom';
  inset: number;
  keyboardHeight?: number;
  base?: number;
}): number {
  const { position, inset, keyboardHeight = 0, base = 8 } = input;
  if (position !== 'bottom') return base;
  const safeInset = Number.isFinite(inset) && inset > 0 ? inset : 0;
  if (Number.isFinite(keyboardHeight) && keyboardHeight > 0) return base;
  return base + safeInset;
}

/** ~70-char line at body size. Phone widths keep the 24px inset on each side. */
const COLUMN_MAX = 560;

/**
 * The widest a sheet may be without stretching across a tablet.
 *
 * Phone widths stay window minus the 24px inset on each side (390 → 342).
 * Wider windows cap at 560 so a session picker, overflow, and Bot detail
 * stay a column instead of a 976-wide strip.
 */
export function sheetMaxWidth(input: { windowWidth: number }): number {
  const { windowWidth } = input;
  const inset = SHEET_MARGIN.bottom.outer * 2;
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return COLUMN_MAX;
  return Math.min(COLUMN_MAX, Math.max(0, Math.round(windowWidth - inset)));
}

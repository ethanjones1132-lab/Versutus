// ─── How far a dragged sheet has moved, and whether it lets go ────
//
// A sheet that only closes through a Close button is a floating card, not a
// phone sheet: Claude, ChatGPT and Grok all let you flick the panel down. The
// gesture itself is two lines of PanResponder in BaseSheet, but the thresholds
// are the whole design — how far a finger must travel, how hard a flick has to
// be, and how much give-back a wrong-way drag gets. Those numbers belong in a
// pure module next to `sheet-height.ts`, where a unit test can pin them
// without mounting a Modal.
//
// It also stays free of the token barrel (`@/constants/tokens` pulls in
// Reanimated, which cannot load in a bare unit test) for the same reason
// `sheet-height.ts` does: restated as plain numbers here, read from tokens by
// the caller where a duration is needed.

/** The one place a gesture is described in numbers. */
export const SHEET_SWIPE = {
  /**
   * Vertical intent needed before the sheet claims the gesture. Small on
   * purpose: it exists to tell a drag apart from a tap on the header, not to
   * demand commitment. The horizontal component is ignored — a sideways swipe
   * inside a sheet is not a dismiss.
   */
  claim: 8,
  /** Travel toward dismissal that commits the close on its own. */
  dismissTravel: 120,
  /** Velocity toward dismissal (px/ms) that commits the close on its own. */
  dismissFlick: 0.5,
  /**
   * Travel a flick has to be paired with. Without it a 0.5px/ms tremor during
   * a tap would close the sheet the user was reaching into.
   */
  flickMinTravel: 24,
  /**
   * How much of a wrong-way drag the sheet gives back. iOS rubber-bands
   * gestures that pull against their own constraint; 0.2 is the same shape, so
   * dragging a bottom sheet UP feels like resistance rather than like a second,
   * upside-down dismissal direction.
   */
  resistance: 0.2,
  /** Ceiling on that give-back, in px. */
  maxLift: 80,
} as const;

/** +1 when dismissal is downward (bottom sheet), -1 when it is upward (top). */
function dismissSign(position: 'top' | 'bottom'): number {
  return position === 'top' ? -1 : 1;
}

/**
 * Where the sheet should sit for a finger that has travelled `delta` px.
 *
 * `delta` is the raw PanResponder `dy` — screen coordinates, so downward is
 * positive whichever edge the sheet hangs from. The position is what turns
 * that into a direction: a bottom sheet is dismissed by pulling DOWN, a top
 * sheet by pulling UP, so the same finger travel dismisses opposite ways.
 *
 * Toward dismissal the sheet follows 1:1 and stops at the offset it animates
 * to when closing, so a long drag parks it exactly where the close animation
 * would have left it. Away from dismissal it resists at `resistance` and stops
 * at `maxLift`, and it can never cross zero into the dismissing direction.
 *
 * The offset is absolute rather than incremental: a drag reads the finger's
 * total travel, so a dropped frame or a granted/revoked responder cannot make
 * the sheet drift away from the finger.
 */
export function sheetSwipeOffset(input: {
  delta: number;
  position: 'top' | 'bottom';
  /** The resting-hidden offset, from BaseSheet's `hiddenOffset`. */
  hiddenTravel: number;
}): number {
  const { delta, position, hiddenTravel } = input;
  if (!Number.isFinite(delta) || !Number.isFinite(hiddenTravel)) return 0;

  const sign = dismissSign(position);
  const toward = delta * sign;
  const limit = Math.abs(hiddenTravel);

  if (toward <= 0) {
    const give = Math.min(Math.abs(toward) * SHEET_SWIPE.resistance, SHEET_SWIPE.maxLift);
    // No movement is no movement on either edge, not a negative zero that a
    // snapshot would print as "-0" and a caller would read as a direction.
    return give === 0 ? 0 : -sign * give;
  }
  return sign * Math.min(toward, limit);
}

/**
 * Whether a released drag closes the sheet.
 *
 * `travel` and `velocity` are magnitudes toward dismissal, so the caller
 * mirrors the raw gesture numbers through `sheetSwipeVelocity` first and this
 * function never has to know which edge the sheet hangs from. Either bar clears
 * the close — a long slow pull, or a short fast flick — and anything short of
 * both goes back to rest.
 */
export function sheetSwipeShouldDismiss(input: {
  travel: number;
  velocity: number;
}): boolean {
  const { travel, velocity } = input;
  if (!Number.isFinite(travel) || travel <= 0) return false;
  if (travel >= SHEET_SWIPE.dismissTravel) return true;
  if (!Number.isFinite(velocity)) return false;
  return velocity >= SHEET_SWIPE.dismissFlick && travel >= SHEET_SWIPE.flickMinTravel;
}

/**
 * Velocity in the dismissing direction, signed: positive means the finger is
 * still heading for dismissal, negative means it is heading back.
 *
 * PanResponder reports px/ms in the same screen-axis frame as `dy`, so a top
 * sheet dismissing upward arrives as a negative `vy`. Mirroring it here — and
 * keeping the sign — is what stops a hard flick the *wrong* way from reading as
 * a flick that closes: `sheetSwipeShouldDismiss` compares against a positive
 * bar, so a negative velocity clears neither bar.
 */
export function sheetSwipeVelocity(input: {
  vy: number;
  position: 'top' | 'bottom';
}): number {
  const { vy, position } = input;
  if (!Number.isFinite(vy)) return 0;
  return vy * dismissSign(position);
}

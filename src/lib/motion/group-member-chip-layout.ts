// Group member chip pin maxWidth — bounds a long provider/model id so one
// group member chip never stretches past half the row even at the six-member
// cap. 360dp with two chips per row + 10px gap means each chip must stay
// ~170px or the wrap drops to one column and the grid shifts during live
// rounds. 120 is the base; it shrinks with fontScale like
// chatHeaderChipMaxWidth so large system fonts keep the pin inside the pill.

export const GROUP_MEMBER_CHIP_PIN_MAX_WIDTH = 120;

/** Effective pin maxWidth that keeps the label inside the pill at a given fontScale. */
export function groupMemberChipPinMaxWidth(fontScale?: number): number {
  const scale =
    Number.isFinite(fontScale as number) && (fontScale as number) > 0
      ? Math.min(fontScale as number, 1.4)
      : 1;
  // Shrink the cap so larger text still fits within the same visual budget.
  return Math.round(GROUP_MEMBER_CHIP_PIN_MAX_WIDTH / scale);
}

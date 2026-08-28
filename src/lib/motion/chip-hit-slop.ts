// Kit Chip touch target — the pill is ~30dp tall (caption lineHeight 18 +
// paddingVertical 6x2 in src/components/ui/Chip.tsx), far under the 48dp
// guideline, and it is the header's most-tapped control (model/session pins
// in chat-header.tsx, member selection in group-room-action-sheet.tsx).
// The slop is invisible to layout: 8 top/bottom brings the effective target
// to ~46dp while the visible pill stays dense. Small horizontal slop keeps
// neighbours in chip wrap rows (gap 8-10) from fighting over taps.
export const CHIP_HIT_SLOP = {
  top: 8,
  bottom: 8,
  left: 4,
  right: 4,
} as const;
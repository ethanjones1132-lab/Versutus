declare const __dirname: string;

import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGroupRoomSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
    'utf8',
  );
}

test('room header rename/disband pills reach a >=44dp effective touch target', () => {
  // Tallest inner element is the micro label (lineHeight 14 per
  // tokens.ts:102; the 12px icon is shorter); renamePill adds
  // paddingVertical Spacing.two (8) * 2 = 16 (group-room-view.tsx:661).
  // The helper's top/bottom slop covers the rest, same as the kit Chip.
  const MICRO_LINE_HEIGHT = 14;
  const PILL_VERTICAL_PADDING = 16;
  expect(CHIP_HIT_SLOP.top).toBeGreaterThanOrEqual(8);
  expect(CHIP_HIT_SLOP.bottom).toBeGreaterThanOrEqual(8);
  const effectiveHeight =
    MICRO_LINE_HEIGHT +
    PILL_VERTICAL_PADDING +
    CHIP_HIT_SLOP.top +
    CHIP_HIT_SLOP.bottom;
  expect(effectiveHeight).toBeGreaterThanOrEqual(44);
});

test('both room header pills carry the helper hitSlop and the padding that reaches 44', () => {
  const src = readGroupRoomSource();
  expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
  // Rename (group-room-view.tsx:396-407) and Disband (:408-416) both render
  // with styles.renamePill; the member-chip pressable uses the conditional
  // `evictable ? CHIP_HIT_SLOP : undefined` form and must not match here.
  expect(src.match(/hitSlop=\{CHIP_HIT_SLOP\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(src).toMatch(/renamePill: \{[^}]*paddingVertical: Spacing\.two[^}]*\}/);
});
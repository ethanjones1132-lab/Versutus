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

test('group member chip slop lifts the ~28dp pill to a >=44dp effective touch target', () => {
  // Tallest inner element is the 22px BotAvatar (caption lineHeight 18 is
  // shorter); memberChip adds paddingVertical 3 * 2 = 6
  // (group-room-view.tsx:662-671). The helper's top/bottom slop covers the rest.
  const BOT_AVATAR_SIZE = 22;
  const CHIP_VERTICAL_PADDING = 6;
  expect(CHIP_HIT_SLOP.top).toBeGreaterThanOrEqual(8);
  expect(CHIP_HIT_SLOP.bottom).toBeGreaterThanOrEqual(8);
  const effectiveHeight =
    BOT_AVATAR_SIZE +
    CHIP_VERTICAL_PADDING +
    CHIP_HIT_SLOP.top +
    CHIP_HIT_SLOP.bottom;
  expect(effectiveHeight).toBeGreaterThanOrEqual(44);
});

test('group member chip applies the helper hitSlop only while it can be removed', () => {
  const src = readGroupRoomSource();
  expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
  // The pressable member chip is the evictable branch at
  // group-room-view.tsx:434-470; evictable gates onPress and disabled, so the
  // slop follows it exactly like the kit Chip idiom (Chip.tsx:36).
  expect(src).toMatch(/hitSlop=\{[^}]*evictable[^}]*\}/);
});
declare const __dirname: string;

import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';

const SEP = __dirname.includes('\\') ? '\\' : '/';

function readChipSource(): string {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'ui', 'Chip.tsx'].join(SEP),
    'utf8',
  );
}

test('chip hit slop lifts the ~30dp pill to a >=44dp effective touch target', () => {
  // Visual pill: caption lineHeight 18 (tokens.ts:101) + paddingVertical
  // (Spacing.one + 2) * 2 = 12 -> ~30dp. Top/bottom slop 8 each reaches 46.
  const CAPTION_LINE_HEIGHT = 18;
  const CHIP_VERTICAL_PADDING = 12;
  expect(CHIP_HIT_SLOP.top).toBeGreaterThanOrEqual(8);
  expect(CHIP_HIT_SLOP.bottom).toBeGreaterThanOrEqual(8);
  const effectiveHeight =
    CAPTION_LINE_HEIGHT + CHIP_VERTICAL_PADDING + CHIP_HIT_SLOP.top + CHIP_HIT_SLOP.bottom;
  expect(effectiveHeight).toBeGreaterThanOrEqual(44);
});

test('kit Chip forwards the helper hitSlop to PressableScale when pressable', () => {
  const src = readChipSource();
  expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
  expect(src).toContain('hitSlop=');
  // The slop is applied only while the chip actually responds to presses.
  expect(src).toMatch(/hitSlop=\{[^}]*onPress[^}]*\}/);
});
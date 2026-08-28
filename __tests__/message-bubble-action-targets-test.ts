declare const __dirname: string;

import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';

const SEP = __dirname.includes('\\') ? '\\' : '/';

function readMessageBubbleSource(): string {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'message-bubble.tsx'].join(SEP),
    'utf8',
  );
}

test('bubble text action slop lifts the ~28dp caption pills to a >=44dp effective touch target', () => {
  // The three shared styles (rawButton/reasoningToggle/actionButton at
  // message-bubble.tsx:348/:365/:384) floor at minHeight 28; the tallest inner
  // element is caption lineHeight 18 (tokens.ts:101). Top/bottom slop 8 each
  // brings the effective target to 44 without growing the visible pill.
  const BUBBLE_ACTION_MIN_HEIGHT = 28;
  expect(CHIP_HIT_SLOP.top).toBeGreaterThanOrEqual(8);
  expect(CHIP_HIT_SLOP.bottom).toBeGreaterThanOrEqual(8);
  const effectiveHeight =
    BUBBLE_ACTION_MIN_HEIGHT + CHIP_HIT_SLOP.top + CHIP_HIT_SLOP.bottom;
  expect(effectiveHeight).toBeGreaterThanOrEqual(44);
});

test('every bubble text action applies the helper hitSlop to PressableScale', () => {
  const src = readMessageBubbleSource();
  expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
  // Five pressables share the three styles: the Thinking toggle
  // (reasoningToggle), Send again / Retry / Cancel (actionButton) and Raw
  // (rawButton). Each must carry the slop; a sixth action adding it later
  // still passes.
  const slopCount = (src.match(/hitSlop=\{CHIP_HIT_SLOP\}/g) ?? []).length;
  expect(slopCount).toBeGreaterThanOrEqual(5);
  expect(src).toMatch(/hitSlop=\{CHIP_HIT_SLOP\}\r?\n\s*style=\{styles\.reasoningToggle\}>/);
  expect(src).toMatch(/hitSlop=\{CHIP_HIT_SLOP\}\r?\n\s*style=\{styles\.rawButton\}>/);
  expect(src).toMatch(/hitSlop=\{CHIP_HIT_SLOP\}\r?\n\s*style=\{styles\.actionButton\}>/);
});
import { sheetMaxHeight, SHEET_MARGIN } from '@/lib/motion/sheet-height';

// The floor is a fallback for a degenerate measurement, not a guaranteed
// height. A sheet taller than the space actually available grows upward off
// the screen and takes its header — eyebrow, title, action — with it, which is
// the overflow the sheet ceiling was written to prevent. Reported by the
// 2026-10-11 quality scan at sheet-height.ts:100.

/** The space the sheet may occupy, computed from the documented inputs. */
function spaceLeft(input: {
  windowHeight: number;
  insetTop?: number;
  insetBottom?: number;
  position?: 'top' | 'bottom';
  keyboardHeight?: number;
}): number {
  const {
    windowHeight,
    insetTop = 0,
    insetBottom = 0,
    position = 'bottom',
    keyboardHeight = 0,
  } = input;
  const margin = SHEET_MARGIN[position];
  const safeInset = insetBottom > 0 ? insetBottom : 0;
  const lift =
    position === 'top' || keyboardHeight <= safeInset ? 0 : keyboardHeight - safeInset;
  return (
    windowHeight - Math.max(0, insetTop) - safeInset - margin.outer - margin.inner - lift
  );
}

test('an open keyboard on a short phone shrinks the sheet below the floor', () => {
  // 640 - 24 top - 42 bottom - 24 outer - 24 inner - (500 - 42) lift = 68.
  const input = {
    windowHeight: 640,
    insetTop: 24,
    insetBottom: 42,
    keyboardHeight: 500,
  };
  const height = sheetMaxHeight(input);
  expect(height).toBe(68);
  expect(height).toBeLessThan(240);
  expect(height).toBeLessThanOrEqual(spaceLeft(input));
});

test('a short measured window is capped even without a keyboard', () => {
  // 260 - 24 outer - 24 inner = 212, below the 240 floor.
  const height = sheetMaxHeight({ windowHeight: 260 });
  expect(height).toBe(212);
  // Less than the 240 default floor, because the window is real and measured.
  expect(height).toBeLessThan(240);
  expect(height).toBeLessThanOrEqual(spaceLeft({ windowHeight: 260 }));
});

test('a top-anchored sheet on a short window uses its own smaller margins', () => {
  // 260 - 40 inset - 8 outer - 8 inner = 204.
  const height = sheetMaxHeight({ windowHeight: 260, insetTop: 40, position: 'top' });
  expect(height).toBe(204);
  expect(height).toBeLessThanOrEqual(
    spaceLeft({ windowHeight: 260, insetTop: 40, position: 'top' }),
  );
});

test('no measured viewport yields a sheet taller than the space available', () => {
  const insets = [
    { insetTop: 0, insetBottom: 0 },
    { insetTop: 24, insetBottom: 42 },
    { insetTop: 47, insetBottom: 34 },
    { insetTop: 96, insetBottom: 48 },
  ];
  const keyboards = [0, 200, 260, 320, 420, 500];
  let checked = 0;
  for (const position of ['bottom', 'top'] as const) {
    for (const inset of insets) {
      for (const windowHeight of [240, 260, 320, 480, 640, 812, 2340]) {
        for (const keyboardHeight of keyboards) {
          const input = { windowHeight, ...inset, position, keyboardHeight };
          const space = spaceLeft(input);
          if (space <= 0) continue;
          checked += 1;
          const height = sheetMaxHeight(input);
          expect(height).toBeLessThanOrEqual(space);
          expect(height).toBe(Math.round(space));
        }
      }
    }
  }
  // The matrix must actually have exercised the measured-and-roomy path.
  expect(checked).toBeGreaterThan(100);
});

test('normal viewports keep the same ceiling as before the fix', () => {
  // 2340 - 96 - 48 - 24 - 24 = 2148; 1000 - 8 - 8 = 984 at the top.
  expect(sheetMaxHeight({ windowHeight: 2340, insetTop: 96, insetBottom: 48 })).toBe(2148);
  expect(sheetMaxHeight({ windowHeight: 1000, position: 'top' })).toBe(984);
});

test('insets that consume the whole window still fall back to the floor', () => {
  // Nothing positive is left to honour; a zero-height sheet would hide every
  // control, so the documented fallback applies. Matches the existing
  // sheet-height test for a very short screen.
  const input = { windowHeight: 200, insetTop: 90, insetBottom: 90 };
  expect(spaceLeft(input)).toBeLessThanOrEqual(0);
  expect(sheetMaxHeight(input)).toBe(240);
});

test('an unmeasured window still falls back to the floor', () => {
  expect(sheetMaxHeight({ windowHeight: 0 })).toBe(240);
  expect(sheetMaxHeight({ windowHeight: Number.NaN })).toBe(240);
  expect(sheetMaxHeight({ windowHeight: -100 })).toBe(240);
});

test('the minimum input is a fallback height, not a lower bound on a measured window', () => {
  expect(sheetMaxHeight({ windowHeight: 0, minimum: 180 })).toBe(180);
  // A measured window with 212 left ignores the 240 default, so it also
  // ignores a custom minimum that would push it past the space available.
  expect(sheetMaxHeight({ windowHeight: 260, minimum: 180 })).toBe(212);
  expect(sheetMaxHeight({ windowHeight: 260, minimum: 300 })).toBe(212);
});

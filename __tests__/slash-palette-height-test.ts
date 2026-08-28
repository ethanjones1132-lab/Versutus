import {
  PALETTE_CHROME,
  PALETTE_LIST_MAX_HEIGHT,
  PALETTE_LIST_MIN_HEIGHT,
  paletteListMaxHeight,
} from '@/lib/motion/slash-palette-height';

test('palette list keeps full 380 on tall window without IME', () => {
  const h = paletteListMaxHeight({ windowHeight: 812, insetTop: 47, insetBottom: 34 });
  expect(h).toBe(PALETTE_LIST_MAX_HEIGHT);
  expect(h).toBe(380);
});

test('palette list caps at 380 on tall web window without insets', () => {
  expect(paletteListMaxHeight({ windowHeight: 900 })).toBe(380);
});

test('palette list shrinks below 380 on 640px phone with IME open', () => {
  const h = paletteListMaxHeight({
    windowHeight: 640,
    insetTop: 24,
    insetBottom: 42,
    keyboardHeight: 270,
  });
  expect(h).toBeLessThan(PALETTE_LIST_MAX_HEIGHT);
  // Must fit inside the sheet shrunken by the IME, not exceed window - keyboard - chrome
  expect(h).toBeLessThanOrEqual(640 - 270 - 80);
  expect(h).toBeGreaterThanOrEqual(PALETTE_LIST_MIN_HEIGHT);
});

test('palette list bounded by windowHeight minus keyboard and chrome', () => {
  const windowHeight = 640;
  const keyboardHeight = 270;
  const insetTop = 24;
  const insetBottom = 42;
  const h = paletteListMaxHeight({ windowHeight, insetTop, insetBottom, keyboardHeight });
  // chrome leaves breathing room; list must not push past sheet ceiling
  expect(h).toBeLessThanOrEqual(windowHeight - keyboardHeight - 50);
  void PALETTE_CHROME;
});

test('palette list never collapses below minimum on tiny or bad window', () => {
  expect(paletteListMaxHeight({ windowHeight: 640, insetTop: 24, insetBottom: 42, keyboardHeight: 320 })).toBeGreaterThanOrEqual(PALETTE_LIST_MIN_HEIGHT);
  expect(paletteListMaxHeight({ windowHeight: 0 })).toBeGreaterThanOrEqual(PALETTE_LIST_MIN_HEIGHT);
  expect(paletteListMaxHeight({ windowHeight: Number.NaN })).toBeGreaterThanOrEqual(PALETTE_LIST_MIN_HEIGHT);
});

test('palette list stays scrollable (keyboard open yields at least min height)', () => {
  const h = paletteListMaxHeight({ windowHeight: 640, insetTop: 10, insetBottom: 10, keyboardHeight: 300 });
  expect(h).toBeGreaterThanOrEqual(PALETTE_LIST_MIN_HEIGHT);
  expect(h).toBeLessThan(PALETTE_LIST_MAX_HEIGHT);
});

test('slash palette component wires dynamic maxHeight via helper', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const src = nodeFs.readFileSync('C:/Projects/Versutus/src/components/chat/slash-command-palette.tsx', 'utf8');
  expect(src).toContain('paletteListMaxHeight');
  expect(src).toContain('useWindowDimensions');
  expect(src).toContain('useSafeAreaInsets');
  expect(src).toContain('keyboardHeight');
  expect(src).toContain('maxHeight: listMaxHeight');
  expect(src).toContain('keyboardShouldPersistTaps=\"handled\"');
});

test('palette list still has a 380 base style with dynamic override', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const src = nodeFs.readFileSync('C:/Projects/Versutus/src/components/chat/slash-command-palette.tsx', 'utf8');
  expect(src).toContain('styles.list');
  // base style keeps 380 as fallback; dynamic style overrides it per window
  expect(src).toContain('maxHeight: 380');
});

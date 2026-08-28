import {
  CHAT_COMPOSER_PALETTE_CHROME,
  CHAT_COMPOSER_PALETTE_MAX_HEIGHT,
  CHAT_COMPOSER_PALETTE_SCROLL_MAX_HEIGHT,
  chatComposerPaletteMaxHeight,
  chatComposerPaletteScrollMaxHeight,
} from '@/lib/motion/chat-composer-palette';
import { paletteListMaxHeight } from '@/lib/motion/slash-palette-height';

test('composer palette keeps full 180 on tall window without IME', () => {
  const h = chatComposerPaletteMaxHeight({ windowHeight: 812, insetTop: 47, insetBottom: 34 });
  expect(h).toBe(CHAT_COMPOSER_PALETTE_MAX_HEIGHT);
  expect(h).toBe(180);
  const scroll = chatComposerPaletteScrollMaxHeight({ windowHeight: 812, insetTop: 47, insetBottom: 34 });
  expect(scroll).toBe(CHAT_COMPOSER_PALETTE_SCROLL_MAX_HEIGHT);
  expect(scroll).toBe(150);
});

test('composer palette tall stays 180 via paletteListMaxHeight', () => {
  expect(chatComposerPaletteMaxHeight({ windowHeight: 900 })).toBe(180);
  expect(paletteListMaxHeight({ windowHeight: 900 })).toBe(380);
  void CHAT_COMPOSER_PALETTE_CHROME;
});

test('composer palette shrinks below 180 on 640px phone with IME open', () => {
  const h = chatComposerPaletteMaxHeight({
    windowHeight: 640,
    insetTop: 24,
    insetBottom: 42,
    keyboardHeight: 270,
  });
  expect(h).toBeLessThan(CHAT_COMPOSER_PALETTE_MAX_HEIGHT);
  expect(h).toBeLessThanOrEqual(640 - 270 - 80);
  expect(h).toBeGreaterThanOrEqual(100);
  const scroll = chatComposerPaletteScrollMaxHeight({
    windowHeight: 640,
    insetTop: 24,
    insetBottom: 42,
    keyboardHeight: 270,
  });
  expect(scroll).toBeLessThan(CHAT_COMPOSER_PALETTE_SCROLL_MAX_HEIGHT);
  expect(scroll).toBeGreaterThanOrEqual(80);
});

test('composer palette bounded by windowHeight minus keyboard and chrome', () => {
  const windowHeight = 640;
  const keyboardHeight = 270;
  const h = chatComposerPaletteMaxHeight({ windowHeight, insetTop: 24, insetBottom: 42, keyboardHeight });
  expect(h).toBeLessThanOrEqual(windowHeight - keyboardHeight - 50);
});

test('composer palette never collapses below minimum on tiny or bad window', () => {
  expect(chatComposerPaletteMaxHeight({ windowHeight: 640, insetTop: 24, insetBottom: 42, keyboardHeight: 320 })).toBeGreaterThanOrEqual(100);
  expect(chatComposerPaletteMaxHeight({ windowHeight: 0 })).toBeGreaterThanOrEqual(100);
  expect(chatComposerPaletteMaxHeight({ windowHeight: Number.NaN })).toBeGreaterThanOrEqual(100);
  expect(chatComposerPaletteScrollMaxHeight({ windowHeight: 0 })).toBeGreaterThanOrEqual(80);
});

test('composer file wires dynamic maxHeight via helper', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const src = nodeFs.readFileSync('C:/Projects/Versutus/src/components/chat/chat-composer.tsx', 'utf8');
  expect(src).toContain('chatComposerPaletteMaxHeight');
  expect(src).toContain('chatComposerPaletteScrollMaxHeight');
  expect(src).toContain('useWindowDimensions');
  expect(src).toContain('useSafeAreaInsets');
  expect(src).toContain('keyboardHeight');
  expect(src).toContain('paletteMaxHeight');
  expect(src).toContain('paletteScrollMaxHeight');
  expect(src).toContain('maxHeight: paletteMaxHeight');
  expect(src).toContain('maxHeight: paletteScrollMaxHeight');
});

test('composer palette still has 180/150 base styles with dynamic override', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const src = nodeFs.readFileSync('C:/Projects/Versutus/src/components/chat/chat-composer.tsx', 'utf8');
  expect(src).toContain('styles.palette');
  expect(src).toContain('maxHeight: 180');
  expect(src).toContain('maxHeight: 150');
});

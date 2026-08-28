import {
  THREAD_CONFIG_CHROME,
  THREAD_CONFIG_LIST_MAX_HEIGHT,
  THREAD_CONFIG_LIST_MIN_HEIGHT,
  threadConfigListMaxHeight,
} from '@/lib/motion/thread-config-list-height';
import { sheetMaxHeight } from '@/lib/motion/sheet-height';

test('thread config list keeps full 380 on tall window without IME', () => {
  const h = threadConfigListMaxHeight({ windowHeight: 812, insetTop: 47, insetBottom: 34 });
  expect(h).toBe(THREAD_CONFIG_LIST_MAX_HEIGHT);
  expect(h).toBe(380);
});

test('thread config list caps at 380 on tall web window without insets', () => {
  expect(threadConfigListMaxHeight({ windowHeight: 900 })).toBe(380);
});

test('thread config list stays 380 on a 640 window without IME', () => {
  expect(threadConfigListMaxHeight({ windowHeight: 640 })).toBe(380);
});

test('thread config list shrinks below 380 on 640px phone with IME open', () => {
  const h = threadConfigListMaxHeight({
    windowHeight: 640,
    insetTop: 24,
    insetBottom: 42,
    keyboardHeight: 270,
  });
  expect(h).toBeLessThan(THREAD_CONFIG_LIST_MAX_HEIGHT);
  // Must fit inside the sheet shrunken by the IME, not exceed window - keyboard - chrome
  expect(h).toBeLessThanOrEqual(640 - 270 - 80);
  expect(h).toBeGreaterThanOrEqual(THREAD_CONFIG_LIST_MIN_HEIGHT);
  // A ~300 sheet leaves ~190 for the list after header/search chrome
  const sheet = sheetMaxHeight({ windowHeight: 640, insetTop: 24, insetBottom: 42, keyboardHeight: 270 });
  expect(sheet).toBeLessThanOrEqual(300);
  expect(h).toBeLessThanOrEqual(sheet - 100);
});

test('thread config list bounded by sheet ceiling minus chrome', () => {
  const windowHeight = 640;
  const keyboardHeight = 270;
  const insetTop = 24;
  const insetBottom = 42;
  const h = threadConfigListMaxHeight({ windowHeight, insetTop, insetBottom, keyboardHeight });
  const sheet = sheetMaxHeight({ windowHeight, insetTop, insetBottom, keyboardHeight });
  // chrome leaves breathing room; list must not push past sheet ceiling
  expect(h + THREAD_CONFIG_CHROME).toBeLessThanOrEqual(sheet);
  expect(h).toBeGreaterThanOrEqual(THREAD_CONFIG_LIST_MIN_HEIGHT);
});

test('thread config list never collapses below minimum on tiny or bad window', () => {
  expect(threadConfigListMaxHeight({ windowHeight: 640, insetTop: 24, insetBottom: 42, keyboardHeight: 320 }))
    .toBeGreaterThanOrEqual(THREAD_CONFIG_LIST_MIN_HEIGHT);
  expect(threadConfigListMaxHeight({ windowHeight: 0 })).toBeGreaterThanOrEqual(THREAD_CONFIG_LIST_MIN_HEIGHT);
  expect(threadConfigListMaxHeight({ windowHeight: Number.NaN })).toBeGreaterThanOrEqual(THREAD_CONFIG_LIST_MIN_HEIGHT);
});

test('thread config list stays scrollable (keyboard open yields at least min height)', () => {
  const h = threadConfigListMaxHeight({ windowHeight: 640, insetTop: 10, insetBottom: 10, keyboardHeight: 300 });
  expect(h).toBeGreaterThanOrEqual(THREAD_CONFIG_LIST_MIN_HEIGHT);
  expect(h).toBeLessThan(THREAD_CONFIG_LIST_MAX_HEIGHT);
});

test('thread config sheet wires dynamic maxHeight via helper on all three lists', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const src = nodeFs.readFileSync('C:/Projects/Versutus/src/components/chat/thread-config-sheet.tsx', 'utf8');
  expect(src).toContain('threadConfigListMaxHeight');
  expect(src).toContain('useWindowDimensions');
  expect(src).toContain('useSafeAreaInsets');
  expect(src).toContain('keyboardHeight');
  // Every section (sessions FlatList, models SectionList, backends FlatList)
  // applies the same dynamic cap.
  expect(src.match(/maxHeight: listMaxHeight/g)?.length).toBe(3);
  expect(src).toContain('keyboardShouldPersistTaps="handled"');
});

test('thread config list still has a flexGrow 0 base style with dynamic override', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const src = nodeFs.readFileSync('C:/Projects/Versutus/src/components/chat/thread-config-sheet.tsx', 'utf8');
  expect(src).toContain('styles.list');
  expect(src).toContain('flexGrow: 0');
});
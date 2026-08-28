import { sheetAnchoredEdgeMargin, sheetContentPaddingBottom, SHEET_MARGIN } from '@/lib/motion/sheet-height';

test('bottom sheet margin includes nav inset when IME is hidden', () => {
  const margin = sheetAnchoredEdgeMargin({ position: 'bottom', inset: 42, keyboardHeight: 0 });
  // Must at least cover the 42px gesture/3-button bar (inner 24 + inset 42 = 66)
  expect(margin).toBe(SHEET_MARGIN.bottom.inner + 42);
  expect(margin).toBeGreaterThanOrEqual(42);
});

test('bottom sheet content padding includes nav inset when IME is hidden', () => {
  const pad = sheetContentPaddingBottom({ position: 'bottom', inset: 42, keyboardHeight: 0 });
  expect(pad).toBe(8 + 42);
  expect(pad).toBeGreaterThan(8);
});

test('bottom sheet content does not double-add inset when IME is open', () => {
  const pad = sheetContentPaddingBottom({ position: 'bottom', inset: 42, keyboardHeight: 320 });
  expect(pad).toBe(8);
});

test('top sheet content padding ignores bottom inset', () => {
  const pad = sheetContentPaddingBottom({ position: 'top', inset: 42, keyboardHeight: 0 });
  expect(pad).toBe(8);
});

test('zero/nonsense inset yields base padding only', () => {
  expect(sheetContentPaddingBottom({ position: 'bottom', inset: 0, keyboardHeight: 0 })).toBe(8);
  expect(sheetContentPaddingBottom({ position: 'bottom', inset: Number.NaN, keyboardHeight: 0 })).toBe(8);
});

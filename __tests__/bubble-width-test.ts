import { bubbleMaxWidth } from '@/lib/motion/bubble-width';

test('user bubbles cap at 85% of the window', () => {
  expect(bubbleMaxWidth(400, false)).toBe(Math.round(400 * 0.85));
});

test('assistant bubbles leave room for the monogram and row gap', () => {
  expect(bubbleMaxWidth(400, true)).toBe(Math.round(400 * 0.85) - (26 + 8));
});

test('tiny widths still leave a readable column', () => {
  expect(bubbleMaxWidth(80, true)).toBeGreaterThanOrEqual(120);
});

test('non-finite widths fall back to 120', () => {
  expect(bubbleMaxWidth(Number.NaN, false)).toBe(120);
});

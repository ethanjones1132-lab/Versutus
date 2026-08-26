import { chatHeaderChipLayout } from '@/lib/motion/chat-header-layout';

test('a 390-wide phone stacks when both chips are offered', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 390, model: true, session: true }),
  ).toBe('stacked');
});

test('a 768-wide window keeps both chips on the title row', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 768, model: true, session: true }),
  ).toBe('row');
});

test('a single chip still fits on a 390-wide phone', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 390, model: true, session: false }),
  ).toBe('row');
  expect(
    chatHeaderChipLayout({ windowWidth: 390, model: false, session: true }),
  ).toBe('row');
});

test('no chips stay on the title row', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 390, model: false, session: false }),
  ).toBe('row');
});

test('an unmeasured window stacks rather than clipping the chips', () => {
  expect(
    chatHeaderChipLayout({ windowWidth: 0, model: true, session: true }),
  ).toBe('stacked');
  expect(
    chatHeaderChipLayout({ windowWidth: Number.NaN, model: true, session: true }),
  ).toBe('stacked');
});

import { screenEdgesFor } from '@/lib/motion/screen-edges';

test('chat with hasDock true keeps the bottom edge on Android', () => {
  expect(screenEdgesFor({ platform: 'android', hasDock: true })).toEqual(['top', 'bottom']);
});

test('chat with hasDock true keeps the bottom edge on iOS', () => {
  expect(screenEdgesFor({ platform: 'ios', hasDock: true })).toEqual(['top', 'bottom']);
});

test('web keeps bottom regardless of hasDock', () => {
  expect(screenEdgesFor({ platform: 'web', hasDock: false })).toEqual(['top', 'bottom']);
});

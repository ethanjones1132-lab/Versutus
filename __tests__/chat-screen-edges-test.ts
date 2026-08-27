import { screenEdgesFor } from '@/lib/motion/screen-edges';

test('chat thread on Android leaves the bottom edge to NativeTabs (no double pad)', () => {
  expect(screenEdgesFor({ platform: 'android', hasDock: false })).toEqual(['top']);
});

test('chat thread on iOS also leaves bottom to NativeTabs when hasDock is false', () => {
  expect(screenEdgesFor({ platform: 'ios', hasDock: false })).toEqual(['top']);
});

test('web keeps bottom regardless of hasDock', () => {
  expect(screenEdgesFor({ platform: 'web', hasDock: false })).toEqual(['top', 'bottom']);
});

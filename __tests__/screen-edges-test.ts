import { screenEdgesFor } from '@/lib/motion/screen-edges';

test('hasDock false leaves bottom to a nested owner on Android', () => {
  expect(screenEdgesFor({ platform: 'android', hasDock: false })).toEqual(['top']);
});

test('hasDock false leaves bottom to a nested owner on iOS', () => {
  expect(screenEdgesFor({ platform: 'ios', hasDock: false })).toEqual(['top']);
});

test('hasDock true keeps the bottom edge for composer / post-tabs screens on iOS', () => {
  expect(screenEdgesFor({ platform: 'ios', hasDock: true })).toEqual(['top', 'bottom']);
});

test('hasDock true keeps the bottom edge on Android', () => {
  expect(screenEdgesFor({ platform: 'android', hasDock: true })).toEqual(['top', 'bottom']);
});

test('web keeps the bottom edge regardless of hasDock', () => {
  expect(screenEdgesFor({ platform: 'web', hasDock: false })).toEqual(['top', 'bottom']);
  expect(screenEdgesFor({ platform: 'web', hasDock: true })).toEqual(['top', 'bottom']);
});

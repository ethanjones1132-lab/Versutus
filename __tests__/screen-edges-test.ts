import { screenEdgesFor } from '@/lib/motion/screen-edges';

test('Home and Activity on Android leave the bottom edge to NativeTabs', () => {
  expect(screenEdgesFor({ platform: 'android', hasDock: false })).toEqual(['top']);
});

test('Home and Activity on iOS leave the bottom edge to NativeTabs', () => {
  expect(screenEdgesFor({ platform: 'ios', hasDock: false })).toEqual(['top']);
});

test('iOS Chat and Terminal keep the bottom edge for the composer', () => {
  expect(screenEdgesFor({ platform: 'ios', hasDock: true })).toEqual(['top', 'bottom']);
});

test('Android Chat keeps the bottom edge until keyboard-lift stops subtracting it', () => {
  expect(screenEdgesFor({ platform: 'android', hasDock: true })).toEqual(['top', 'bottom']);
});

test('web keeps the bottom edge because NativeTabs does not document a web inset', () => {
  expect(screenEdgesFor({ platform: 'web', hasDock: false })).toEqual(['top', 'bottom']);
  expect(screenEdgesFor({ platform: 'web', hasDock: true })).toEqual(['top', 'bottom']);
});

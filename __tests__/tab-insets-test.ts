import {
  TAB_HOME_BASE_PADDING,
  TAB_ROSTER_BASE_PADDING,
  tabContentPaddingBottom,
} from '@/lib/motion/tab-insets';

test('android gesture bar adds inset to home/activity padding', () => {
  expect(tabContentPaddingBottom({ platform: 'android', insetBottom: 42 })).toBe(
    TAB_HOME_BASE_PADDING + 42,
  );
});

test('android roster base adds inset', () => {
  expect(
    tabContentPaddingBottom({ platform: 'android', insetBottom: 42, base: TAB_ROSTER_BASE_PADDING }),
  ).toBe(TAB_ROSTER_BASE_PADDING + 42);
});

test('android zero/negative/nonsense inset falls back to base', () => {
  expect(tabContentPaddingBottom({ platform: 'android', insetBottom: 0 })).toBe(TAB_HOME_BASE_PADDING);
  expect(tabContentPaddingBottom({ platform: 'android', insetBottom: -10 })).toBe(
    TAB_HOME_BASE_PADDING,
  );
  expect(tabContentPaddingBottom({ platform: 'android', insetBottom: Number.NaN })).toBe(
    TAB_HOME_BASE_PADDING,
  );
});

test('ios keeps base regardless of inset (NativeTabs owns bottom)', () => {
  expect(tabContentPaddingBottom({ platform: 'ios', insetBottom: 42 })).toBe(TAB_HOME_BASE_PADDING);
  expect(
    tabContentPaddingBottom({ platform: 'ios', insetBottom: 42, base: TAB_ROSTER_BASE_PADDING }),
  ).toBe(TAB_ROSTER_BASE_PADDING);
});

test('web keeps base regardless of inset', () => {
  expect(tabContentPaddingBottom({ platform: 'web', insetBottom: 42 })).toBe(TAB_HOME_BASE_PADDING);
});

test('custom base honoured on android and ios', () => {
  expect(tabContentPaddingBottom({ platform: 'android', insetBottom: 24, base: 16 })).toBe(40);
  expect(tabContentPaddingBottom({ platform: 'ios', insetBottom: 24, base: 16 })).toBe(16);
});

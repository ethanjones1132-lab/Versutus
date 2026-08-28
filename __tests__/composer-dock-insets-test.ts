import { COMPOSER_DOCK_BASE_PADDING, composerDockPaddingBottom, composerKeyboardLiftForTest } from '@/lib/motion/composer-dock-insets';
import { composerKeyboardLift } from '@/lib/motion/keyboard-lift';

test('android inset 42 hidden => dock >=50 (8 + inset)', () => {
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 42 })).toBe(
    COMPOSER_DOCK_BASE_PADDING + 42,
  );
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 42 })).toBeGreaterThanOrEqual(50);
  // lift itself when hidden is the inset
  expect(composerKeyboardLift(0, 42)).toBe(42);
  expect(composerKeyboardLiftForTest(0, 42)).toBe(42);
});

test('android hidden with zero or invalid inset stays at base', () => {
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 0 })).toBe(COMPOSER_DOCK_BASE_PADDING);
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: -10 })).toBe(COMPOSER_DOCK_BASE_PADDING);
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: Number.NaN })).toBe(COMPOSER_DOCK_BASE_PADDING);
  expect(composerKeyboardLift(0, 0)).toBe(0);
  expect(composerKeyboardLift(0, -10)).toBe(0);
});

test('android with IME lifts above keyboard (keyboardHeight - inset)', () => {
  // keyboard 270 on 3-button (42) => 8 + 228 = 236
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 42, keyboardHeight: 270 })).toBe(
    COMPOSER_DOCK_BASE_PADDING + 228,
  );
  expect(composerKeyboardLift(270, 42)).toBe(228);
  // gesture nav 24
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 24, keyboardHeight: 270 })).toBe(
    COMPOSER_DOCK_BASE_PADDING + 246,
  );
});

test('ios keeps base regardless of inset or keyboard', () => {
  expect(composerDockPaddingBottom({ platform: 'ios', insetBottom: 42 })).toBe(COMPOSER_DOCK_BASE_PADDING);
  expect(composerDockPaddingBottom({ platform: 'ios', insetBottom: 42, keyboardHeight: 270 })).toBe(COMPOSER_DOCK_BASE_PADDING);
});

test('web keeps base regardless of inset', () => {
  expect(composerDockPaddingBottom({ platform: 'web', insetBottom: 42 })).toBe(COMPOSER_DOCK_BASE_PADDING);
});

test('custom base honoured on android hidden and with keyboard', () => {
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 42, base: 16 })).toBe(58);
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 42, keyboardHeight: 270, base: 16 })).toBe(
    16 + 228,
  );
});

test('invalid base falls back to default', () => {
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 10, base: Number.NaN })).toBe(
    COMPOSER_DOCK_BASE_PADDING + 10,
  );
  expect(composerDockPaddingBottom({ platform: 'android', insetBottom: 10, base: -5 })).toBe(
    COMPOSER_DOCK_BASE_PADDING + 10,
  );
});

test('composer file wires lift via ComposerKeyboardLift with dock styles', () => {
  const fs = require('fs');
  const composer = fs.readFileSync('src/components/chat/chat-composer.tsx', 'utf8');
  expect(composer).toMatch(/ComposerKeyboardLift/);
  expect(composer).toMatch(/styles\.dock/);
  const group = fs.readFileSync('src/components/chat/group-room-view.tsx', 'utf8');
  expect(group).toMatch(/ComposerKeyboardLift/);
  expect(group).toMatch(/styles\.dock/);
  const lift = fs.readFileSync('src/lib/motion/keyboard-lift.ts', 'utf8');
  // hidden case must return inset, not 0
  expect(lift).toMatch(/return inset/);
});

import { CHAT_JUMP_BASE_BOTTOM, chatJumpBottom } from '@/lib/motion/chat-jump-inset';

test('android inset lifts pill above nav bar', () => {
  expect(chatJumpBottom({ platform: 'android', insetBottom: 42 })).toBe(CHAT_JUMP_BASE_BOTTOM + 42);
  expect(chatJumpBottom({ platform: 'android', insetBottom: 42 })).toBeGreaterThanOrEqual(50);
});

test('android zero or invalid inset stays at base', () => {
  expect(chatJumpBottom({ platform: 'android', insetBottom: 0 })).toBe(CHAT_JUMP_BASE_BOTTOM);
  expect(chatJumpBottom({ platform: 'android', insetBottom: -10 })).toBe(CHAT_JUMP_BASE_BOTTOM);
  expect(chatJumpBottom({ platform: 'android', insetBottom: Number.NaN })).toBe(
    CHAT_JUMP_BASE_BOTTOM,
  );
});

test('ios keeps base regardless of inset', () => {
  expect(chatJumpBottom({ platform: 'ios', insetBottom: 42 })).toBe(CHAT_JUMP_BASE_BOTTOM);
  expect(chatJumpBottom({ platform: 'ios', insetBottom: 34 })).toBe(CHAT_JUMP_BASE_BOTTOM);
});

test('web keeps base regardless of inset', () => {
  expect(chatJumpBottom({ platform: 'web', insetBottom: 42 })).toBe(CHAT_JUMP_BASE_BOTTOM);
});

test('custom base honoured on android and ios', () => {
  expect(chatJumpBottom({ platform: 'android', insetBottom: 42, base: 16 })).toBe(58);
  expect(chatJumpBottom({ platform: 'ios', insetBottom: 42, base: 16 })).toBe(16);
});

test('invalid base falls back to default', () => {
  expect(chatJumpBottom({ platform: 'android', insetBottom: 10, base: Number.NaN })).toBe(
    CHAT_JUMP_BASE_BOTTOM + 10,
  );
  expect(chatJumpBottom({ platform: 'android', insetBottom: 10, base: -5 })).toBe(
    CHAT_JUMP_BASE_BOTTOM + 10,
  );
});

import { CHAT_TRANSCRIPT_BASE_PADDING, chatTranscriptContentPaddingBottom } from '@/lib/motion/chat-transcript-insets';

test('android gesture bar adds inset to transcript padding', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: 42 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING + 42,
  );
});

test('android 3-button bar tail is not clipped when gesture is zero', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: 0 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
});

test('android nonsense inset falls back to base', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: Number.NaN })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: -10 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
});

test('ios keeps base padding regardless of inset (NativeTabs owns bottom)', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'ios', insetBottom: 34 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
  expect(chatTranscriptContentPaddingBottom({ platform: 'ios', insetBottom: 42 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
});

test('web keeps base padding regardless of inset', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'web', insetBottom: 42 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
});

test('custom base is honoured and still adds inset on android', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: 24, base: 24 })).toBe(48);
  expect(chatTranscriptContentPaddingBottom({ platform: 'ios', insetBottom: 24, base: 24 })).toBe(24);
});

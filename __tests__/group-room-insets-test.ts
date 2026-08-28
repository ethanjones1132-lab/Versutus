import { CHAT_TRANSCRIPT_BASE_PADDING, chatTranscriptContentPaddingBottom } from '@/lib/motion/chat-transcript-insets';

declare const __dirname: string;

test('android gesture bar adds inset to group room transcript padding', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: 42 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING + 42,
  );
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: 42 })).toBeGreaterThanOrEqual(50);
});

test('android zero or invalid inset falls back to base for group room', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: 0 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: -10 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
  expect(chatTranscriptContentPaddingBottom({ platform: 'android', insetBottom: Number.NaN })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
});

test('ios keeps base padding regardless of inset for group room', () => {
  expect(chatTranscriptContentPaddingBottom({ platform: 'ios', insetBottom: 42 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
  expect(chatTranscriptContentPaddingBottom({ platform: 'ios', insetBottom: 34 })).toBe(
    CHAT_TRANSCRIPT_BASE_PADDING,
  );
});

test('group room ScrollView wires transcript bottom padding helper via safe-area insets', () => {
  const SEP = __dirname.includes('\\') ? '\\' : '/';
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const file = [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP);
  const src = nodeFs.readFileSync(file, 'utf8');
  expect(src).toContain('chatTranscriptContentPaddingBottom');
  expect(src).toContain('useSafeAreaInsets');
  expect(src).toContain('insets.bottom');
  // Wired into ScrollView contentContainerStyle as array merging styles.scroll with dynamic paddingBottom
  expect(src).toContain('contentContainerStyle={[');
  expect(src).toContain('Platform.OS');
});

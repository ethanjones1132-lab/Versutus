jest.mock('react-native-reanimated', () => {
  const { View, Text, ScrollView, Pressable } = require('react-native');
  const createAnimatedComponent = (component: unknown) => component;
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : proxy),
      apply: () => proxy,
    });
    return proxy;
  };
  return {
    __esModule: true,
    default: { View, Text, ScrollView, Pressable, createAnimatedComponent },
    Easing: { bezier: () => (v: number) => v, elastic: () => (v: number) => v, out: (fn: (v: number) => number) => fn, inOut: (fn: (v: number) => number) => fn, cubic: (v: number) => v, ease: (v: number) => v },
    useSharedValue: (value: unknown) => ({ value, get: () => value, set: () => undefined }),
    useAnimatedStyle: () => ({}),
    withTiming: (value: unknown, _c?: unknown, cb?: (finished: boolean) => void) => {
      if (typeof cb === 'function') cb(true);
      return value;
    },
    withSpring: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    runOnJS: (fn: unknown) => fn,
    FadeIn: { duration: chain, easing: chain, delay: chain },
    FadeOut: { duration: chain, easing: chain, delay: chain },
    FadeInDown: { duration: chain, easing: chain, delay: chain },
    createAnimatedComponent,
    View,
    Text,
    ScrollView,
  };
});

jest.mock('@shopify/react-native-skia', () => ({
  Canvas: 'Canvas',
  Fill: 'Fill',
  Shader: 'Shader',
  Skia: {},
  Group: 'Group',
  Circle: 'Circle',
  Path: 'Path',
  LinearGradient: 'LinearGradient',
  SweepGradient: 'SweepGradient',
  useClock: () => 0,
  usePathValue: () => ({ current: null }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ setOptions: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

jest.mock('@/components/chat/command-history-section', () => ({ CommandHistorySection: () => null }));
jest.mock('@/components/chat/session-analytics', () => ({ SessionAnalytics: () => null }));
jest.mock('@/components/chat/bot-approval-policy', () => ({ BotApprovalPolicyRow: () => null }));
jest.mock('@/components/chat/bot-memory-pane', () => ({ BotMemoryPane: () => null }));

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatOverflowSheet } from '@/components/chat/chat-overflow-sheet';
import { BotDetailSheet } from '@/components/chat/bot-detail-sheet';
import { MessageActionsSheet } from '@/components/chat/message-actions-sheet';
import { BaseSheet } from '@/components/ui';

const overflowProps = {
  onClose: () => undefined,
  onReloadHistory: () => undefined,
  onNewSession: () => undefined,
  onDisconnect: () => undefined,
  rowCount: 0,
};

declare const __dirname: string;
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const SEP = __dirname.includes('\\') ? '\\' : '/';

describe('OVF-1 overflow title', () => {
  test('the source title is a real ampersand, not an HTML entity', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'components', 'chat', 'chat-overflow-sheet.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src).toContain('title="Session & connection"');
    expect(src).not.toContain('&amp;');
  });

  test('the sheet title is Session & connection, not the HTML entity', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(ChatOverflowSheet, { ...overflowProps, visible: true }));
    });

    const titles = renderer.root.findAllByType(BaseSheet).map((node) => node.props.title);
    expect(titles).toContain('Session & connection');
    expect(titles.join(' ')).not.toContain('&amp;');
    renderer.unmount();
  });
});

describe('V-4 remaining chat sheet wrappers keep BaseSheet on close', () => {
  test('ChatOverflowSheet', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(ChatOverflowSheet, { ...overflowProps, visible: true }));
    });
    await act(async () => {
      renderer.update(createElement(ChatOverflowSheet, { ...overflowProps, visible: false }));
    });
    const sheets = renderer.root.findAllByType(BaseSheet);
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.some((node) => node.props.visible === false)).toBe(true);
    renderer.unmount();
  });

  test('MessageActionsSheet', async () => {
    const message = { id: 'm1', role: 'user' as const, text: 'hi', timestamp: 1 };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(MessageActionsSheet, {
          visible: true,
          message,
          onClose: () => undefined,
        }),
      );
    });
    await act(async () => {
      renderer.update(
        createElement(MessageActionsSheet, {
          visible: false,
          message,
          onClose: () => undefined,
        }),
      );
    });
    const sheets = renderer.root.findAllByType(BaseSheet);
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.some((node) => node.props.visible === false)).toBe(true);
    renderer.unmount();
  });

  test('BotDetailSheet', async () => {
    const bot = { id: 'forge', displayName: 'Forge', routable: true };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(BotDetailSheet, { bot, onClose: () => undefined }));
    });
    await act(async () => {
      renderer.update(createElement(BotDetailSheet, { bot: null, onClose: () => undefined }));
    });
    const sheets = renderer.root.findAllByType(BaseSheet);
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.some((node) => node.props.visible === false)).toBe(true);
    renderer.unmount();
  });
});

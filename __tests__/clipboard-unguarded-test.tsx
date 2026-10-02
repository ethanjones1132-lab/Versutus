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

jest.mock('@/components/ui', () => {
  const React = require('react');
  const { TextInput } = require('react-native');
  const actual = jest.requireActual('@/components/ui');
  return {
    ...actual,
    TextField: (props: Record<string, unknown>) => React.createElement(TextInput, props),
    Skeleton: () => null,
  };
});

jest.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => {
    throw new Error('clipboard unavailable');
  }),
}));

jest.mock('@/components/chat/bot-approval-policy', () => ({ BotApprovalPolicyRow: () => null }));
jest.mock('@/components/chat/bot-memory-pane', () => ({ BotMemoryPane: () => null }));

const mockGateway = {
  commandTranscripts: [
    {
      id: 'cmd-1',
      gatewayId: 'gw-1',
      sessionKey: 'session-a',
      input: '/status',
      title: 'status',
      status: 'complete',
      summary: 'ok',
      createdAt: 1,
    },
  ],
};
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
}));

jest.mock('@/lib/gateway/transcript-share', () => ({
  transcriptShareAvailable: async () => false,
  shareTranscriptFile: async () => false,
}));

import * as Clipboard from 'expo-clipboard';
import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BotDetailSheet } from '@/components/chat/bot-detail-sheet';
import { CommandHistorySection } from '@/components/chat/command-history-section';
import { CodeBlock } from '@/components/chat/markdown/code-block';
import { MessageActionsSheet } from '@/components/chat/message-actions-sheet';
import { Button, ListRow } from '@/components/ui';

const BUTTON = Button as unknown as ElementType;
const LIST_ROW = ListRow as unknown as ElementType;
const mockSetStringAsync = Clipboard.setStringAsync as jest.Mock;

function trackUnhandled() {
  const seen: unknown[] = [];
  const on = (reason: unknown) => {
    seen.push(reason);
  };
  process.on('unhandledRejection', on);
  return {
    seen,
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    },
    stop() {
      process.off('unhandledRejection', on);
    },
  };
}

describe('CLIP-1 clipboard writes', () => {
  beforeEach(() => {
    mockSetStringAsync.mockReset();
    mockSetStringAsync.mockRejectedValue(new Error('clipboard unavailable'));
  });

  test('Copy code, Copy Markdown, Copy profile id, and Copy text swallow a refusal and still dismiss the message sheet', async () => {
    const track = trackUnhandled();
    const onClose = jest.fn();
    let renderer!: ReactTestRenderer;

    try {
      await act(async () => {
        renderer = create(createElement(CodeBlock, { code: 'const a = 1;', language: 'ts' }));
      });
      const copyCode = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Copy code')[0];
      await act(async () => {
        copyCode.props.onPress();
      });
      await track.flush();
      renderer.unmount();

      await act(async () => {
        renderer = create(createElement(CommandHistorySection));
      });
      const disclosure = renderer.root.findAll(
        (node) => typeof node.props.accessibilityLabel === 'string' && String(node.props.accessibilityLabel).includes('Command history'),
      )[0];
      await act(async () => {
        await disclosure.props.onPress();
      });
      const copyMd = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Copy Markdown');
      expect(copyMd).toBeDefined();
      await act(async () => {
        copyMd?.props.onPress();
      });
      await track.flush();
      renderer.unmount();

      await act(async () => {
        renderer = create(
          createElement(BotDetailSheet, {
            bot: { id: 'forge', displayName: 'Forge', routable: true },
            onClose: () => undefined,
          }),
        );
      });
      const copyId = renderer.root.findAllByType(LIST_ROW).find((node) => node.props.title === 'Copy profile id');
      expect(copyId).toBeDefined();
      await act(async () => {
        copyId?.props.onPress();
      });
      await track.flush();
      renderer.unmount();

      await act(async () => {
        renderer = create(
          createElement(MessageActionsSheet, {
            visible: true,
            message: {
              id: 'm1',
              role: 'assistant',
              text: 'hello',
              timestamp: Date.now(),
            },
            onClose,
          }),
        );
      });
      const copyText = renderer.root.findAllByType(LIST_ROW).find((node) => node.props.title === 'Copy text');
      expect(copyText).toBeDefined();
      await act(async () => {
        copyText?.props.onPress();
      });
      await track.flush();

      expect(mockSetStringAsync).toHaveBeenCalled();
      expect(track.seen).toEqual([]);
      expect(onClose).toHaveBeenCalled();
    } finally {
      track.stop();
      renderer?.unmount();
    }
  });
});

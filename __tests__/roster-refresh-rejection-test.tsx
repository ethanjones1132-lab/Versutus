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
    createAnimatedComponent,
    View,
    Text,
    ScrollView,
    FadeIn: { duration: chain, easing: chain, delay: chain },
    FadeOut: { duration: chain, easing: chain, delay: chain },
    FadeInDown: { duration: chain, easing: chain, delay: chain },
    Keyframe: class {
      duration() {
        return this;
      }
      easing() {
        return this;
      }
    },
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

jest.mock('@/components/chat/bot-avatar', () => ({ BotAvatar: 'BotAvatar', GroupAvatar: 'GroupAvatar' }));
jest.mock('@/components/connection-badge', () => ({
  PulsingDot: 'PulsingDot',
  statusColor: () => '#000',
  statusLabel: () => 'connected',
}));
jest.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

import { createElement } from 'react';
import { RefreshControl } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatRoster } from '@/components/chat/chat-roster';

describe('ROS-1 roster pull-to-refresh', () => {
  test('a rejecting onRefresh does not leak an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const onRefresh = jest.fn(() => Promise.reject(new Error('offline')));
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          createElement(ChatRoster, {
            rows: [],
            connected: true,
            onSelectConfigurable: () => undefined,
            onSelectBot: () => undefined,
            onRefresh,
          }),
        );
      });

      const control = renderer.root.findByType(RefreshControl);
      await act(async () => {
        control.props.onRefresh();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });

      expect(onRefresh).toHaveBeenCalled();
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      renderer?.unmount();
    }
  });
});

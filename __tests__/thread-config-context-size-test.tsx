/**
 * Context-size label in the Models list.
 *
 * `formatContext` divided by 1000 and rounded, so a 1500-token context read
 * "2k ctx" (a size it does not have) and a 1M context read "1000k ctx" (a
 * unit nobody writes). The row is rendered for real here so the assertion is
 * on the text an operator reads, not on the shape of the source.
 *
 * The mocks below are the same set `thread-config-hop-test.tsx` uses to mount
 * this sheet, so the test exercises the real section components.
 */

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
    useAnimatedKeyboard: () => ({ height: { value: 0 } }),
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

jest.mock('@/lib/gateway/session-labels', () => {
  const actual =
    jest.requireActual('@/lib/gateway/session-labels') as typeof import('@/lib/gateway/session-labels');
  return {
    ...actual,
    loadSessionLabels: jest.fn(async () => ({})),
    saveSessionLabels: jest.fn(async () => undefined),
  };
});

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ThreadConfigSheet } from '@/components/chat/thread-config-sheet';

function collectText(root: ReactTestRenderer['root']): string {
  return root
    .findAll(() => true)
    .flatMap((node) => {
      const children = node.props?.children;
      if (typeof children === 'string' || typeof children === 'number') return [String(children)];
      if (Array.isArray(children)) {
        return children
          .filter((child) => typeof child === 'string' || typeof child === 'number')
          .map(String);
      }
      return [];
    })
    .join('\n');
}

async function mountWithContexts(contexts: number[]): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(ThreadConfigSheet, {
        mode: 'models',
        availableModes: ['models'],
        onModeChange: () => undefined,
        onClose: () => undefined,
        models: contexts.map((context, index) => ({
          id: `labs/model-${index}`,
          provider: 'Labs',
          context,
        })),
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

test('a 1500-token context reads 1.5k, not a rounded 2k', async () => {
  const renderer = await mountWithContexts([1500]);
  const text = collectText(renderer.root);
  expect(text).toContain('1.5k ctx');
  expect(text).not.toContain('2k ctx');
  renderer.unmount();
});

test('a million-token context reads 1M, not 1000k', async () => {
  const renderer = await mountWithContexts([1_000_000]);
  const text = collectText(renderer.root);
  expect(text).toContain('1M ctx');
  expect(text).not.toContain('1000k ctx');
  renderer.unmount();
});

test('whole thousands and sub-thousand counts stay clean', async () => {
  const renderer = await mountWithContexts([2000, 500]);
  const text = collectText(renderer.root);
  expect(text).toContain('2k ctx');
  expect(text).not.toContain('2.0k ctx');
  expect(text).toContain('500 ctx');
  renderer.unmount();
});

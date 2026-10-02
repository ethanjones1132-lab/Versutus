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
  const actual = jest.requireActual('@/lib/gateway/session-labels') as typeof import('@/lib/gateway/session-labels');
  return {
    ...actual,
    loadSessionLabels: jest.fn(async () => ({})),
    saveSessionLabels: jest.fn(async () => undefined),
  };
});

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ThreadConfigSheet } from '@/components/chat/thread-config-sheet';
import type { ThreadConfigMode } from '@/lib/gateway/thread-config';
import { BaseSheet, Button } from '@/components/ui';

const BUTTON = Button as unknown as ElementType;

function collectText(root: ReactTestRenderer['root']): string {
  return root
    .findAll(() => true)
    .flatMap((node) => {
      const children = node.props?.children;
      if (typeof children === 'string' || typeof children === 'number') return [String(children)];
      if (Array.isArray(children)) {
        return children.filter((child) => typeof child === 'string' || typeof child === 'number').map(String);
      }
      return [];
    })
    .join('\n');
}

const sessions = [{ id: 'ses_1', title: 'Research' }];

const baseProps = {
  availableModes: ['sessions', 'models'] as ThreadConfigMode[],
  onModeChange: () => undefined,
  onClose: () => undefined,
  sessions,
  sessionsLoaded: true,
  gatewayId: 'gw-1',
  currentSessionId: 'ses_1',
};

describe('THS-1 thread-config section hop', () => {
  test('a half-typed session name survives hopping to Models and back', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(ThreadConfigSheet, {
          ...baseProps,
          mode: 'sessions',
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const rename = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Rename session Research',
    )[0];
    expect(rename).toBeDefined();
    await act(async () => {
      await rename.props.onPress();
    });

    const field = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Name for session Research',
    )[0];
    expect(field).toBeDefined();
    await act(async () => {
      field.props.onChangeText('typed-name');
    });
    expect(field.props.value).toBe('typed-name');

    await act(async () => {
      renderer.update(
        createElement(ThreadConfigSheet, {
          ...baseProps,
          mode: 'models',
        }),
      );
    });
    await act(async () => {
      renderer.update(
        createElement(ThreadConfigSheet, {
          ...baseProps,
          mode: 'sessions',
        }),
      );
    });

    const kept = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Name for session Research',
    )[0];
    expect(kept).toBeDefined();
    expect(kept.props.value).toBe('typed-name');
    renderer.unmount();
  });
});

describe('V-3 open-by-id rejection', () => {
  test('a rejecting onOpenById sets the error line and does not leak', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          createElement(ThreadConfigSheet, {
            ...baseProps,
            mode: 'sessions',
            onOpenSessionById: () => Promise.reject(new Error('offline')),
          }),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });

      const idField = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Session id')[0];
      await act(async () => {
        idField.props.onChangeText('ses_missing');
      });

      const open = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Open');
      await act(async () => {
        open?.props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });

      expect(collectText(renderer.root)).toMatch(/offline/);
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      renderer?.unmount();
    }
  });
});

describe('V-4 thread-config exit', () => {
  test('closing the sheet keeps BaseSheet mounted with visible={false}', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(ThreadConfigSheet, {
          ...baseProps,
          mode: 'sessions',
        }),
      );
    });
    expect(renderer.root.findByType(BaseSheet).props.visible).toBe(true);

    await act(async () => {
      renderer.update(
        createElement(ThreadConfigSheet, {
          ...baseProps,
          mode: null,
        }),
      );
    });

    const sheets = renderer.root.findAllByType(BaseSheet);
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.some((node) => node.props.visible === false)).toBe(true);
    renderer.unmount();
  });
});

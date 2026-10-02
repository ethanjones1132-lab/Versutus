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

import { createElement, type ElementType } from 'react';
import { TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ApprovalSheet } from '@/components/chat/approval-sheet';
import { BaseSheet, Button } from '@/components/ui';

const BUTTON = Button as unknown as ElementType;

describe('APR-1 approval sheet feedback', () => {
  test('a new runId starts with an empty feedback box and Approve forwards none', async () => {
    const onApprove = jest.fn();
    const onDeny = jest.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        createElement(ApprovalSheet, {
          visible: true,
          runId: 'run-a',
          prompt: 'read the repo',
          onApprove,
          onDeny,
        }),
      );
    });

    const field = renderer.root.findByType(TextInput);
    await act(async () => {
      field.props.onChangeText('safe, it only reads the repo');
    });
    expect(field.props.value).toBe('safe, it only reads the repo');

    await act(async () => {
      renderer.update(
        createElement(ApprovalSheet, {
          visible: true,
          runId: 'run-b',
          prompt: 'write a file',
          onApprove,
          onDeny,
        }),
      );
    });

    const nextField = renderer.root.findByType(TextInput);
    expect(nextField.props.value).toBe('');

    const approve = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Approve');
    await act(async () => {
      await approve?.props.onPress();
    });
    expect(onApprove).toHaveBeenCalledWith(undefined);
    renderer.unmount();
  });
});

describe('V-4 approval sheet exit', () => {
  test('hiding the sheet keeps BaseSheet mounted with visible={false}', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(ApprovalSheet, {
          visible: true,
          runId: 'run-a',
          onApprove: () => undefined,
          onDeny: () => undefined,
        }),
      );
    });
    expect(renderer.root.findByType(BaseSheet).props.visible).toBe(true);

    await act(async () => {
      renderer.update(
        createElement(ApprovalSheet, {
          visible: false,
          runId: 'run-a',
          onApprove: () => undefined,
          onDeny: () => undefined,
        }),
      );
    });

    const sheets = renderer.root.findAllByType(BaseSheet);
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.some((node) => node.props.visible === false)).toBe(true);
    renderer.unmount();
  });
});

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

jest.mock('@/components/chat/markdown/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('@/components/chat/streaming-indicator', () => ({ StreamingIndicator: 'StreamingIndicator' }));
jest.mock('@/components/chat/bot-avatar', () => ({ BotAvatar: 'BotAvatar' }));
jest.mock('@/components/layout/ComposerKeyboardLift', () => ({
  ComposerKeyboardLift: ({ children }: { children: unknown }) => children,
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { GroupRoomView } from '@/components/chat/group-room-view';
import { Button, Chip } from '@/components/ui';

const BUTTON = Button as unknown as ElementType;
const CHIP = Chip as unknown as ElementType;

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

describe('GRP-1 group room error line', () => {
  test('a successful add retry clears the failure line', async () => {
    const group = { id: 'room-1', name: 'Standup', memberIds: ['forge', 'muse'] };
    const members = [
      { id: 'forge', displayName: 'Forge', routable: true },
      { id: 'muse', displayName: 'Muse', routable: true },
      { id: 'scout', displayName: 'Scout', routable: true },
    ];
    const onAddMembers = jest
      .fn()
      .mockRejectedValueOnce(new Error('Gate unreachable'))
      .mockResolvedValueOnce({ ...group, memberIds: [...group.memberIds, 'scout'] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(GroupRoomView, {
          group,
          members,
          draft: '',
          onDraftChange: () => undefined,
          onSend: async () => ({ replies: [] }),
          onRename: async (name: string) => ({ ...group, name }),
          onLeave: async () => group,
          onDisband: async () => undefined,
          onAddMembers,
          loadHistory: async () => [],
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const add = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Add members')[0];
    await act(async () => {
      add.props.onPress();
    });

    const scout = renderer.root.findAllByType(CHIP).find((node) => node.props.label === 'Scout');
    expect(scout).toBeDefined();
    await act(async () => {
      await scout?.props.onPress();
    });

    const submit = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Add to room');
    await act(async () => {
      submit?.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(collectText(renderer.root)).toContain('Gate unreachable');

    const retry = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Add to room');
    await act(async () => {
      retry?.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onAddMembers).toHaveBeenCalledTimes(2);
    expect(collectText(renderer.root)).not.toContain('Gate unreachable');
    renderer.unmount();
  });
});

/**
 * A Gate-stored room transcript that is still loading when the room re-renders.
 * The parent hands GroupRoomView a fresh loadHistory closure on every render; a
 * re-render mid-load used to cancel the read and the re-run skipped it, so the
 * replayed lines were dropped and the skeleton stayed up. The read now happens
 * once per mount and a prop-identity change neither cancels nor repeats it.
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
    Skeleton: 'Skeleton',
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
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { GroupRoomView } from '@/components/chat/group-room-view';
import type { GroupTranscriptEntry } from '@/lib/gateway/groups';

const SKELETON = 'Skeleton' as ElementType;

/** Every string the tree was handed as a prop or a child, in render order. */
function renderedStrings(root: ReactTestInstance): string[] {
  return root.findAll(() => true).flatMap((node) =>
    Object.values(node.props ?? {}).flatMap((value) => {
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) return value.filter((child): child is string => typeof child === 'string');
      return [];
    }),
  );
}

describe('group room history survives a parent re-render', () => {
  test('a re-render mid-load keeps the read, shows the lines, and does not read twice', async () => {
    const group = { id: 'room-1', name: 'Standup', memberIds: ['forge', 'muse'] };
    const members = [
      { id: 'forge', displayName: 'Forge', routable: true },
      { id: 'muse', displayName: 'Muse', routable: true },
    ];
    const stored: GroupTranscriptEntry[] = [
      { id: 'line-1', role: 'bot', botId: 'forge', text: 'Forge has the stored line', at: 1 },
    ];
    let release!: (rows: GroupTranscriptEntry[]) => void;
    const pending = new Promise<GroupTranscriptEntry[]>((resolve) => {
      release = resolve;
    });
    const loadHistory = jest.fn(() => pending);

    // The parent builds the prop inline, so every render hands a new closure.
    const props = (readHistory: () => Promise<GroupTranscriptEntry[]>) => ({
      group,
      members,
      draft: '',
      onDraftChange: () => undefined,
      onSend: async () => ({ replies: [] }),
      onRename: async (name: string) => ({ ...group, name }),
      onLeave: async () => group,
      onDisband: async () => undefined,
      loadHistory: readHistory,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(GroupRoomView, props(() => loadHistory())));
    });
    await act(async () => {
      renderer.update(createElement(GroupRoomView, props(() => loadHistory())));
    });
    expect(renderer.root.findAllByType(SKELETON).length).toBeGreaterThan(0);

    await act(async () => {
      release(stored);
      await pending;
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType(SKELETON)).toHaveLength(0);
    expect(renderedStrings(renderer.root)).toContain('Forge has the stored line');

    // A later parent re-render does not repeat the read either.
    await act(async () => {
      renderer.update(createElement(GroupRoomView, props(() => loadHistory())));
    });
    expect(loadHistory).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});

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

jest.mock('@/components/chat/bot-approval-policy', () => ({ BotApprovalPolicyRow: () => null }));
jest.mock('@/components/chat/bot-memory-pane', () => ({ BotMemoryPane: () => null }));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';

import { BotDetailSheet } from '@/components/chat/bot-detail-sheet';
import { Button, Text } from '@/components/ui';
import type { BotSoulState, PublicBot } from '@/lib/gateway/bots';

const TEXT = Text as unknown as ElementType;
const BUTTON = Button as unknown as ElementType;

const BOT_A: PublicBot = { id: 'forge', displayName: 'Forge', routable: true };
const BOT_B: PublicBot = { id: 'archivist', displayName: 'Archivist', routable: true };
const LONG_SOUL = 'You are precise about evidence and name what is uncertain. '.repeat(20).trim();
const SHORT_SOUL = 'Be curious.';

function loadedSoul(soul: string | null): BotSoulState {
  return { soul, loaded: true, failed: false };
}

function sheetFor(bot: PublicBot | null, soul?: BotSoulState, onRetry?: () => void) {
  return createElement(BotDetailSheet, { bot, soul, onClose: () => undefined, onRetry });
}

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

/** The one Text that renders the soul body, so its line cap can be read. */
function soulBody(root: ReactTestRenderer['root'], soul: string): ReactTestInstance {
  const bodies = root.findAllByType(TEXT).filter((node) => node.props.children === soul);
  expect(bodies).toHaveLength(1);
  return bodies[0];
}

/** The header disclosure, or undefined when the soul is too short to collapse. */
function soulToggle(root: ReactTestRenderer['root']): ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Soul, '),
  )[0];
}

describe('bot detail soul disclosure', () => {
  test('a long soul opens as a three-line preview with a Show all affordance', async () => {
    // The soul used to render every line of a long SOUL.md, pushing the
    // auto-approve row, memory, model pin and actions far down the sheet.
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul(LONG_SOUL)));
    });

    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBe(3);
    const toggle = soulToggle(renderer.root);
    expect(toggle).toBeDefined();
    expect(toggle?.props.accessibilityRole).toBe('button');
    expect(toggle?.props.accessibilityState).toEqual({ expanded: false });
    expect(toggle?.props.accessibilityLabel).toBe('Soul, preview shown');
    expect(collectText(renderer.root)).toContain('Show all');

    act(() => { renderer.unmount(); });
  });

  test('pressing the header expands the full soul and pressing again collapses it', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul(LONG_SOUL)));
    });

    await act(async () => {
      await soulToggle(renderer.root)?.props.onPress?.();
    });

    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBeUndefined();
    const expanded = soulToggle(renderer.root);
    expect(expanded?.props.accessibilityState).toEqual({ expanded: true });
    expect(expanded?.props.accessibilityLabel).toBe('Soul, shown in full');
    expect(collectText(renderer.root)).not.toContain('Show all');

    await act(async () => {
      await expanded?.props.onPress?.();
    });

    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBe(3);
    expect(soulToggle(renderer.root)?.props.accessibilityState).toEqual({ expanded: false });

    act(() => { renderer.unmount(); });
  });

  test('Show all expands the soul too', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul(LONG_SOUL)));
    });

    const showAll = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Show the whole soul',
    )[0];
    expect(showAll).toBeDefined();
    await act(async () => {
      await showAll?.props.onPress?.();
    });

    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBeUndefined();
    act(() => { renderer.unmount(); });
  });

  test('a short soul is shown in full with no toggle', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul(SHORT_SOUL)));
    });

    expect(soulBody(renderer.root, SHORT_SOUL).props.numberOfLines).toBeUndefined();
    expect(soulToggle(renderer.root)).toBeUndefined();
    expect(collectText(renderer.root)).not.toContain('Show all');

    act(() => { renderer.unmount(); });
  });

  test('the threshold is more than 280 characters or more than four lines', async () => {
    // "About 4 lines or 280 characters": both counts are a collapse trigger,
    // so a wall of short lines does not sneak past the character budget.
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul('x'.repeat(280))));
    });
    expect(soulBody(renderer.root, 'x'.repeat(280)).props.numberOfLines).toBeUndefined();
    act(() => { renderer.unmount(); });

    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul('x'.repeat(281))));
    });
    expect(soulBody(renderer.root, 'x'.repeat(281)).props.numberOfLines).toBe(3);
    act(() => { renderer.unmount(); });

    const fourLines = 'one\ntwo\nthree\nfour';
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul(fourLines)));
    });
    expect(soulBody(renderer.root, fourLines).props.numberOfLines).toBeUndefined();
    act(() => { renderer.unmount(); });

    const fiveLines = 'one\ntwo\nthree\nfour\nfive';
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul(fiveLines)));
    });
    expect(soulBody(renderer.root, fiveLines).props.numberOfLines).toBe(3);
    act(() => { renderer.unmount(); });
  });

  test('a failed read keeps its note and Retry visible over a collapsed soul', async () => {
    // The skeleton, failure note and Retry sit outside the disclosure body:
    // a read that failed is never hidden behind a collapsed preview.
    const onRetry = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        sheetFor(BOT_A, { soul: LONG_SOUL, loaded: false, failed: true }, onRetry),
      );
    });

    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBe(3);
    expect(collectText(renderer.root)).toContain('The soul could not be read.');
    const labels = renderer.root.findAllByType(BUTTON).map((node) => node.props.label);
    expect(labels).toContain('Retry');

    act(() => { renderer.unmount(); });
  });

  test('a failed re-read keeps its note while the last soul stays collapsed', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(sheetFor(BOT_A, { soul: LONG_SOUL, loaded: true, failed: true }));
    });

    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBe(3);
    expect(collectText(renderer.root)).toContain(
      'Could not re-read the soul — showing the last one.',
    );

    act(() => { renderer.unmount(); });
  });

  test('showing a different Bot resets the soul to a collapsed preview', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul(LONG_SOUL)));
    });
    await act(async () => {
      await soulToggle(renderer.root)?.props.onPress?.();
    });
    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBeUndefined();

    await act(async () => {
      renderer.update(sheetFor(BOT_B, loadedSoul(LONG_SOUL)));
    });

    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBe(3);
    expect(soulToggle(renderer.root)?.props.accessibilityState).toEqual({ expanded: false });

    act(() => { renderer.unmount(); });
  });

  test('dismissing and reopening the same Bot starts collapsed again', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(sheetFor(BOT_A, loadedSoul(LONG_SOUL)));
    });
    await act(async () => {
      await soulToggle(renderer.root)?.props.onPress?.();
    });
    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBeUndefined();

    await act(async () => {
      renderer.update(sheetFor(null));
    });
    await act(async () => {
      renderer.update(sheetFor(BOT_A, loadedSoul(LONG_SOUL)));
    });

    expect(soulBody(renderer.root, LONG_SOUL).props.numberOfLines).toBe(3);
    act(() => { renderer.unmount(); });
  });
});

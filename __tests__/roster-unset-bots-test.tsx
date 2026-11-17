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

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatRoster } from '@/components/chat/chat-roster';
import type { ChatRosterProps } from '@/components/chat/chat-roster';
import type { PublicBot } from '@/lib/gateway/bots';
import { groupRosterRows, unsetBotsLabel } from '@/lib/gateway/roster-sections';

jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({ accent: '#000', accentMuted: '#000', backgroundElevated: '#000', border: '#000', stageGlass: '#000', specular: '#000' }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/chat/bot-avatar', () => ({ BotAvatar: 'BotAvatar', GroupAvatar: 'GroupAvatar' }));
jest.mock('@/components/connection-badge', () => ({ PulsingDot: 'PulsingDot', statusColor: () => '#000' }));
jest.mock('@/components/ui', () => ({
  Button: 'Button', Chip: 'Chip', EmptyState: 'EmptyState', Icon: 'Icon', PressableScale: 'PressableScale',
  Skeleton: 'Skeleton', Text: 'Text', TextField: 'TextField',
}));
jest.mock('@/lib/haptics', () => ({ haptics: { selection: jest.fn() } }));

const ready: PublicBot = { id: 'ready', displayName: 'Ready Ranger', routable: true };
const unset: PublicBot = { id: 'unset', displayName: 'Unset Smith', routable: false };
const multiplex: PublicBot = {
  id: 'multiplex',
  displayName: 'Mux Bot',
  routable: false,
  routingIssue: 'multiplex_disabled',
};
const room = { id: 'room-1', name: 'War room', memberIds: ['ready'] };

function baseProps(patch: Partial<ChatRosterProps> = {}): ChatRosterProps {
  return {
    rows: [
      { kind: 'configurable' },
      { kind: 'bot', bot: ready },
      { kind: 'bot', bot: unset },
      { kind: 'bot', bot: multiplex },
    ],
    connected: true,
    groups: [room],
    gatewayName: 'Studio',
    onSelectConfigurable: jest.fn(),
    onSelectBot: jest.fn(),
    onBotDetail: jest.fn(),
    ...patch,
  };
}

async function mount(props: ChatRosterProps) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ChatRoster, props)); });
  return renderer;
}

function textValues(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('Text' as never).map((node) => {
    const value = node.props.children;
    return typeof value === 'string' ? value : '';
  });
}

/** The pressable currently carrying this accessibility label. */
function pressable(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAll((candidate) => candidate.props?.accessibilityLabel === label)
    .find((candidate) => typeof candidate.props?.onPress === 'function');
  if (!node) throw new Error(`no pressable labelled "${label}"`);
  return node;
}

describe('groupRosterRows', () => {
  test('keeps Direct chat on the ready shelf and folds every unroutable Bot', () => {
    const rows = baseProps().rows;
    const sections = groupRosterRows(rows);
    expect(sections.ready.map((row) => (row.kind === 'bot' ? row.bot.id : row.kind))).toEqual([
      'configurable',
      'ready',
    ]);
    expect(sections.unset.map((row) => (row.kind === 'bot' ? row.bot.id : row.kind))).toEqual([
      'unset',
      'multiplex',
    ]);
  });

  test('the fold line counts the way a person says it', () => {
    expect(unsetBotsLabel(0)).toBe('0 Bots not set up');
    expect(unsetBotsLabel(1)).toBe('1 Bot not set up');
    expect(unsetBotsLabel(16)).toBe('16 Bots not set up');
  });
});

describe('unset Bots on the home roster', () => {
  test('ready Bots, Direct chat and group chats are on the first screen; unset Bots are behind one row', async () => {
    const renderer = await mount(baseProps());
    const visible = textValues(renderer).join(' ');

    expect(visible).toContain('Direct chat');
    expect(visible).toContain('Ready Ranger');
    expect(visible).toContain('War room');
    // The two that need setup are counted, not painted row by row.
    expect(visible).toContain('2 Bots not set up');
    expect(visible).not.toContain('Unset Smith');
    expect(visible).not.toContain('Mux Bot');

    await act(async () => renderer.unmount());
  });

  test('expanding shows them in place, and each row still opens its fix', async () => {
    const props = baseProps();
    const renderer = await mount(props);

    await act(async () => {
      await pressable(renderer, '2 Bots not set up. Show them.').props.onPress();
    });

    const visible = textValues(renderer).join(' ');
    expect(visible).toContain('Unset Smith');
    expect(visible).toContain('Mux Bot');
    expect(visible).toContain('2 Bots not set up');
    // The fold now offers the way back shut.
    expect(visible).toContain('Hide them');

    await act(async () => {
      await pressable(renderer, 'Unset Smith, Not set up yet').props.onPress();
    });
    expect(props.onBotDetail).toHaveBeenCalledWith(unset);
    expect(props.onSelectBot).not.toHaveBeenCalledWith(unset);

    await act(async () => renderer.unmount());
  });

  test('a single unset Bot is said in the singular', async () => {
    const renderer = await mount(
      baseProps({ rows: [{ kind: 'configurable' }, { kind: 'bot', bot: ready }, { kind: 'bot', bot: unset }] }),
    );
    expect(textValues(renderer).join(' ')).toContain('1 Bot not set up');
    await act(async () => renderer.unmount());
  });

  test('the backend filter narrows the fold as well as the rows', async () => {
    const hermesReady: PublicBot = { ...ready, runtime: 'hermes', backendId: 'hermes' };
    const hermesUnset: PublicBot = { ...unset, runtime: 'hermes', backendId: 'hermes' };
    const openCodeUnset: PublicBot = { ...multiplex, runtime: 'opencode', backendId: 'opencode' };
    const renderer = await mount(
      baseProps({
        rows: [
          { kind: 'configurable' },
          { kind: 'bot', bot: hermesReady },
          { kind: 'bot', bot: hermesUnset },
          { kind: 'bot', bot: openCodeUnset },
        ],
      }),
    );
    expect(textValues(renderer).join(' ')).toContain('2 Bots not set up');

    const chips = renderer.root.findAllByType('Chip' as never);
    await act(async () => { chips[2].props.onPress(); });

    const visible = textValues(renderer).join(' ');
    expect(visible).toContain('1 Bot not set up');
    // The Hermes Bot no longer contributes to the fold, and its row is not on
    // the shelf that the filter removed.
    expect(visible).not.toContain('Unset Smith');
    await act(async () => renderer.unmount());
  });

  test('an active search shows matching unset Bots without unfolding by hand', async () => {
    const renderer = await mount(baseProps());
    const search = renderer.root.findByType('TextField' as never);
    await act(async () => { search.props.onChangeText('Smith'); });

    const visible = textValues(renderer).join(' ');
    // A match must never sit behind a shut fold.
    expect(visible).toContain('Unset Smith');
    expect(visible).not.toContain('Ready Ranger');
    await act(async () => renderer.unmount());
  });
});

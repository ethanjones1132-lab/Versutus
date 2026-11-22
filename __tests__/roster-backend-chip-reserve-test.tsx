/**
 * VS-135: the Home roster's backend chips resolve after the roster has already
 * painted (a Bot from a second runtime arrives with a later read). The strip
 * the chips occupy is therefore reserved from the first paint, so the chips
 * fill their own box instead of pushing every row down — a tap made while they
 * were pending lands on the Bot the operator aimed at.
 *
 * If the reservation is removed (or made conditional on the chips existing),
 * the "pending" render below has no strip and these tests fail.
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
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatRoster } from '@/components/chat/chat-roster';
import type { ChatRosterProps } from '@/components/chat/chat-roster';
import { BACKEND_FILTER_SLOT_HEIGHT } from '@/components/ui/backend-filter-row';
import type { PublicBot } from '@/lib/gateway/bots';

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

const hermes: PublicBot = { id: 'hermes-bot', displayName: 'Hermes Scout', routable: true, runtime: 'hermes', backendId: 'hermes' };
const openCode: PublicBot = { id: 'opencode-bot', displayName: 'OpenCode Builder', routable: true, runtime: 'opencode', backendId: 'opencode' };

/** One runtime on first paint: no chip row has resolved, so none is drawn. */
const PENDING_ROWS: ChatRosterProps['rows'] = [{ kind: 'configurable' }, { kind: 'bot', bot: hermes }];
/** The second runtime arrives: the chip row is now drawn. */
const RESOLVED_ROWS: ChatRosterProps['rows'] = [
  { kind: 'configurable' },
  { kind: 'bot', bot: hermes },
  { kind: 'bot', bot: openCode },
];

function baseProps(patch: Partial<ChatRosterProps> = {}): ChatRosterProps {
  return {
    rows: PENDING_ROWS,
    connected: true,
    gatewayName: 'Studio',
    onSelectConfigurable: jest.fn(),
    onSelectBot: jest.fn(),
    ...patch,
  };
}

async function mount(props: ChatRosterProps) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ChatRoster, props)); });
  return renderer;
}

const SLOT = 'roster-backend-filter-slot';

/** The reserved strip, wherever it sits in the header. */
function filterSlot(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ testID: SLOT });
}

function slotStyle(renderer: ReactTestRenderer): { minHeight?: number } {
  return StyleSheet.flatten(filterSlot(renderer).props.style) as { minHeight?: number };
}

function textValues(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('Text' as never).map((node) => {
    const value = node.props.children;
    return typeof value === 'string' ? value : '';
  });
}

describe('ChatRoster backend chip reservation (VS-135)', () => {
  test('the chip strip is reserved while no backend chip has resolved', async () => {
    const renderer = await mount(baseProps());
    // Nothing to press yet — but the space it will need is already held.
    expect(filterSlot(renderer).findAllByType('Chip' as never)).toHaveLength(0);
    expect(slotStyle(renderer).minHeight).toBe(BACKEND_FILTER_SLOT_HEIGHT);
    expect(BACKEND_FILTER_SLOT_HEIGHT).toBeGreaterThan(0);
    await act(async () => renderer.unmount());
  });

  test('a chip that resolves later fills the same box: no row moves', async () => {
    const renderer = await mount(baseProps());
    const pendingHeight = slotStyle(renderer).minHeight;
    const pendingRows = textValues(renderer);

    await act(async () => {
      renderer.update(createElement(ChatRoster, baseProps({ rows: RESOLVED_ROWS })));
    });

    // The chips arrived, inside the strip that was waiting for them…
    expect(filterSlot(renderer).findAllByType('Chip' as never).map((chip) => chip.props.label)).toEqual([
      'All',
      'Hermes',
      'OpenCode',
    ]);
    // …and that strip's height is unchanged, so the header's height — and
    // therefore every roster row's offset below it — is unchanged too.
    expect(slotStyle(renderer).minHeight).toBe(pendingHeight);
    expect(slotStyle(renderer).minHeight).toBe(BACKEND_FILTER_SLOT_HEIGHT);
    // One reservation, however many nodes carry the testID (composite + host).
    expect(renderer.root.findAllByProps({ testID: SLOT }).length).toBeGreaterThan(0);

    // The row the operator was reaching for is still drawn, still in place.
    expect(textValues(renderer)).toEqual(expect.arrayContaining(pendingRows));
    await act(async () => renderer.unmount());
  });
});

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
const room = { id: 'room-1', name: 'War room', memberIds: ['hermes-bot', 'opencode-bot'] };

function baseProps(patch: Partial<ChatRosterProps> = {}): ChatRosterProps {
  return {
    rows: [{ kind: 'configurable' }, { kind: 'bot', bot: hermes }, { kind: 'bot', bot: openCode }],
    connected: true,
    groups: [room],
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

function textValues(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('Text' as never).map((node) => {
    const value = node.props.children;
    return typeof value === 'string' ? value : '';
  });
}

describe('ChatRoster backend filter', () => {
  test('hides the filter for a single runtime', async () => {
    const renderer = await mount(baseProps({ rows: [{ kind: 'configurable' }, { kind: 'bot', bot: hermes }] }));
    expect(renderer.root.findAllByType('Chip' as never)).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  test('defaults to All; runtime selection preserves Direct chat and Rooms', async () => {
    const renderer = await mount(baseProps());
    const chips = renderer.root.findAllByType('Chip' as never);
    expect(chips.map((chip) => chip.props.label)).toEqual(['All', 'Hermes', 'OpenCode']);
    expect(chips.map((chip) => chip.props.selected)).toEqual([true, false, false]);
    await act(async () => { chips[2].props.onPress(); });
    const visible = textValues(renderer).join(' ');
    expect(visible).toContain('Direct chat');
    expect(visible).toContain('OpenCode Builder');
    expect(visible).not.toContain('Hermes Scout');
    expect(visible).toContain('War room');
    await act(async () => renderer.unmount());
  });

  test('search combines with the selected backend', async () => {
    const renderer = await mount(baseProps());
    const chips = renderer.root.findAllByType('Chip' as never);
    await act(async () => { chips[2].props.onPress(); });
    const search = renderer.root.findByType('TextField' as never);
    await act(async () => { search.props.onChangeText('Builder'); });
    expect(textValues(renderer).join(' ')).toContain('OpenCode Builder');
    expect(textValues(renderer).join(' ')).not.toContain('Hermes Scout');
    await act(async () => renderer.unmount());
  });

  test('falls back to All when the selected runtime disappears', async () => {
    const renderer = await mount(baseProps());
    let chips = renderer.root.findAllByType('Chip' as never);
    await act(async () => { chips[2].props.onPress(); });
    await act(async () => {
      renderer.update(createElement(ChatRoster, baseProps({ rows: [{ kind: 'configurable' }, { kind: 'bot', bot: hermes }] })));
    });
    chips = renderer.root.findAllByType('Chip' as never);
    expect(chips).toHaveLength(0);
    expect(textValues(renderer).join(' ')).toContain('Hermes Scout');
    await act(async () => renderer.unmount());
  });

  test('a different gateway starts on All again', async () => {
    const renderer = await mount(baseProps());
    let chips = renderer.root.findAllByType('Chip' as never);
    await act(async () => { chips[2].props.onPress(); });
    chips = renderer.root.findAllByType('Chip' as never);
    expect(chips.map((chip) => chip.props.selected)).toEqual([false, false, true]);
    await act(async () => {
      renderer.update(createElement(ChatRoster, baseProps({ gatewayName: 'Atlas' })));
    });
    chips = renderer.root.findAllByType('Chip' as never);
    expect(chips.map((chip) => chip.props.selected)).toEqual([true, false, false]);
    expect(textValues(renderer).join(' ')).toContain('Hermes Scout');
    await act(async () => renderer.unmount());
  });
});

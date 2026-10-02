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

jest.mock('@/components/chat/bot-approval-policy', () => ({ BotApprovalPolicyRow: () => null }));

const gatewayRequest = jest.fn();
const mockGateway = {
  status: 'connected' as const,
  gatewayRequest,
  activeGateway: { id: 'gw-1', name: 'Gate', url: 'http://localhost' },
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BotDetailSheet } from '@/components/chat/bot-detail-sheet';
import { BotMemoryPane } from '@/components/chat/bot-memory-pane';
import { Button } from '@/components/ui';

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

function byLabel(root: ReactTestRenderer['root'], label: string) {
  return root.findAll((node) => node.props.accessibilityLabel === label);
}

const longMemory = Array.from({ length: 2000 }, (_, i) => `line-${i + 1}`).join('\n');

describe('BOT-1 / V-1 / V-2 bot memory pane', () => {
  beforeEach(() => {
    gatewayRequest.mockReset();
    gatewayRequest.mockImplementation(async (method: string) => {
      if (method === 'bots.memory') {
        return { files: [{ name: 'MEMORY.md', text: longMemory }] };
      }
      if (method === 'bots.memory.write') return {};
      throw new Error(`unexpected ${method}`);
    });
  });

  test('V-1: opening a Bot detail sheet does not read bots.memory until Memory is opened', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(BotDetailSheet, {
          bot: { id: 'forge', displayName: 'Forge', routable: true },
          onClose: () => undefined,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gatewayRequest.mock.calls.some((call) => call[0] === 'bots.memory')).toBe(false);

    const toggle = byLabel(renderer.root, 'Memory')[0];
    expect(toggle).toBeDefined();
    await act(async () => {
      await toggle.props.onPress?.();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gatewayRequest).toHaveBeenCalledWith('bots.memory', { id: 'forge' });
    renderer.unmount();
  });

  test('BOT-1: an empty query mounts a window of lines, not every line of a large file', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(BotMemoryPane, { botId: 'forge' }));
    });

    const toggle = byLabel(renderer.root, 'Memory')[0];
    await act(async () => {
      await toggle.props.onPress?.();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(gatewayRequest).toHaveBeenCalledWith('bots.memory', { id: 'forge' });
    const body = collectText(renderer.root);
    const rendered = new Set(body.match(/line-\d+/g) ?? []);
    expect(body).toMatch(/Showing first 80 of 2000/);
    expect(rendered.size).toBe(80);
    expect(rendered.has('line-1')).toBe(true);
    expect(rendered.has('line-80')).toBe(true);
    expect(rendered.has('line-81')).toBe(false);
    expect(rendered.has('line-2000')).toBe(false);
    renderer.unmount();
  });

  test('V-2: a successful write keeps the saved text when the re-read fails', async () => {
    gatewayRequest.mockImplementation(async (method: string) => {
      if (method === 'bots.memory') {
        return { files: [{ name: 'MEMORY.md', text: 'original memory' }] };
      }
      if (method === 'bots.memory.write') return {};
      throw new Error(`unexpected ${method}`);
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(BotMemoryPane, { botId: 'forge' }));
    });
    const toggle = byLabel(renderer.root, 'Memory')[0];
    await act(async () => {
      await toggle.props.onPress?.();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const edit = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Edit');
    expect(edit).toBeDefined();
    await act(async () => {
      edit?.props.onPress();
    });

    const field = renderer.root.findAll((node) => node.props.value === 'original memory')[0];
    expect(field).toBeDefined();
    await act(async () => {
      field.props.onChangeText('saved memory');
    });

    const save = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Save');
    await act(async () => {
      save?.props.onPress();
    });
    const confirm = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Confirm save');
    expect(confirm).toBeDefined();

    gatewayRequest.mockImplementation(async (method: string) => {
      if (method === 'bots.memory.write') return {};
      if (method === 'bots.memory') throw new Error('offline');
      throw new Error(`unexpected ${method}`);
    });

    await act(async () => {
      await confirm?.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const body = collectText(renderer.root);
    expect(body).toContain('saved memory');
    expect(body).not.toContain('Memory could not be read from the Gate host.');
    expect(body).toMatch(/Could not re-read memory/);
    renderer.unmount();
  });
});

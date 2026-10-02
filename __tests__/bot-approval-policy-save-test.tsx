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
    Easing: { bezier: () => (v: number) => v, elastic: () => (v: number) => v, inOut: (fn: (v: number) => number) => fn, ease: (v: number) => v },
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    withTiming: (value: unknown) => value,
    withSpring: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
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

const mockStore = new Map<string, string>();
const mockSetItem = jest.fn(async (key: string, value: string) => {
  mockStore.set(key, value);
});
const mockGetItem = jest.fn(async (key: string) => mockStore.get(key) ?? null);

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: (key: string) => mockGetItem(key),
    setItem: (key: string, value: string) => mockSetItem(key, value),
    removeItem: jest.fn(async (key: string) => {
      mockStore.delete(key);
    }),
  },
}));

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    activeGateway: { id: 'gw-1', name: 'Gate', url: 'http://localhost' },
  }),
}));

import { createElement } from 'react';
import { Switch } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BotApprovalPolicyRow } from '@/components/chat/bot-approval-policy';
import { APPROVAL_POLICIES_STORAGE_KEY } from '@/lib/gateway/approval-policy';

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

describe('POL-1 approval policy switch', () => {
  beforeEach(() => {
    mockStore.clear();
    mockGetItem.mockClear();
    mockSetItem.mockReset();
    mockSetItem.mockImplementation(async (key: string, value: string) => {
      mockStore.set(key, value);
    });
  });

  test('a refused save rolls the copy back to asking before every command', async () => {
    mockSetItem.mockRejectedValue(new Error('disk full'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(BotApprovalPolicyRow, { botId: 'forge' }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(collectText(renderer.root)).toContain('This Bot asks before every command.');

    const toggle = renderer.root.findByType(Switch);
    await act(async () => {
      await toggle.props.onValueChange(true);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSetItem).toHaveBeenCalled();
    expect(mockSetItem.mock.calls[0][0]).toBe(APPROVAL_POLICIES_STORAGE_KEY);
    expect(collectText(renderer.root)).toContain('This Bot asks before every command.');
    expect(collectText(renderer.root)).not.toMatch(/without a card/);
    renderer.unmount();
  });
});

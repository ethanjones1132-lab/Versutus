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
import { APPROVAL_POLICIES_STORAGE_KEY, approvalPolicyKey, approvalPolicyDecision, loadApprovalPolicies, readApprovalPoliciesStrict } from '@/lib/gateway/approval-policy';

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

/** Let the row's load effect and any follow-up state land before asserting. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });
}

async function mountRow(botId: string): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(BotApprovalPolicyRow, { botId }));
  });
  await settle();
  return renderer;
}

async function flip(renderer: ReactTestRenderer, next: boolean): Promise<void> {
  const toggle = renderer.root.findByType(Switch);
  await act(async () => {
    await toggle.props.onValueChange(next);
  });
  await settle();
}

describe('POL-1 approval policy switch', () => {
  beforeEach(() => {
    mockStore.clear();
    mockGetItem.mockReset();
    mockGetItem.mockImplementation(async (key: string) => mockStore.get(key) ?? null);
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

  test('a successful toggle keeps another Bot opt-in in the stored map', async () => {
    const otherKey = approvalPolicyKey('gw-1', 'scout');
    mockStore.set(
      APPROVAL_POLICIES_STORAGE_KEY,
      JSON.stringify({ [otherKey]: { autoApproveRead: true } }),
    );

    const renderer = await mountRow('forge');
    expect(collectText(renderer.root)).toContain('This Bot asks before every command.');

    await flip(renderer, true);

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(mockStore.get(APPROVAL_POLICIES_STORAGE_KEY) ?? '{}') as Record<
      string,
      { autoApproveRead?: boolean }
    >;
    expect(saved[otherKey]).toEqual({ autoApproveRead: true });
    expect(saved[approvalPolicyKey('gw-1', 'forge')]).toEqual({ autoApproveRead: true });
    expect(collectText(renderer.root)).toMatch(/without a card/);
    renderer.unmount();
  });

  test('turning this Bot off keeps another Bot opt-in in the stored map', async () => {
    const otherKey = approvalPolicyKey('gw-1', 'scout');
    const thisKey = approvalPolicyKey('gw-1', 'forge');
    mockStore.set(
      APPROVAL_POLICIES_STORAGE_KEY,
      JSON.stringify({ [otherKey]: { autoApproveRead: true }, [thisKey]: { autoApproveRead: true } }),
    );

    const renderer = await mountRow('forge');
    expect(collectText(renderer.root)).toMatch(/without a card/);

    await flip(renderer, false);

    const saved = JSON.parse(mockStore.get(APPROVAL_POLICIES_STORAGE_KEY) ?? '{}') as Record<
      string,
      { autoApproveRead?: boolean }
    >;
    expect(saved[otherKey]).toEqual({ autoApproveRead: true });
    expect(saved[thisKey]).toBeUndefined();
    renderer.unmount();
  });

  test('a thrown read refuses the save and leaves the stored map untouched', async () => {
    const otherKey = approvalPolicyKey('gw-1', 'scout');
    const storedBlob = JSON.stringify({ [otherKey]: { autoApproveRead: true } });
    mockStore.set(APPROVAL_POLICIES_STORAGE_KEY, storedBlob);
    mockGetItem.mockRejectedValue(new Error('storage unavailable'));

    const renderer = await mountRow('forge');
    expect(collectText(renderer.root)).toContain('This Bot asks before every command.');

    await flip(renderer, true);

    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockStore.get(APPROVAL_POLICIES_STORAGE_KEY)).toBe(storedBlob);
    expect(collectText(renderer.root)).toContain('This Bot asks before every command.');
    renderer.unmount();
  });

  test('a read that fails while the switch was on puts the switch back on, not off', async () => {
    const thisKey = approvalPolicyKey('gw-1', 'forge');
    const storedBlob = JSON.stringify({ [thisKey]: { autoApproveRead: true } });
    mockStore.set(APPROVAL_POLICIES_STORAGE_KEY, storedBlob);

    const renderer = await mountRow('forge');
    expect(collectText(renderer.root)).toMatch(/without a card/);

    mockGetItem.mockRejectedValue(new Error('storage unavailable'));
    await flip(renderer, false);

    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockStore.get(APPROVAL_POLICIES_STORAGE_KEY)).toBe(storedBlob);
    expect(collectText(renderer.root)).toMatch(/without a card/);
    renderer.unmount();
  });

  test('corrupt stored json refuses the save and leaves the bytes alone', async () => {
    mockStore.set(APPROVAL_POLICIES_STORAGE_KEY, '{not json');

    const renderer = await mountRow('forge');
    expect(collectText(renderer.root)).toContain('This Bot asks before every command.');

    await flip(renderer, true);

    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockStore.get(APPROVAL_POLICIES_STORAGE_KEY)).toBe('{not json');
    expect(collectText(renderer.root)).toContain('This Bot asks before every command.');
    renderer.unmount();
  });

  test('a stored value that is not a policy map refuses the save', async () => {
    const storedBlob = '[{"gw-1:scout":{"autoApproveRead":true}}]';
    mockStore.set(APPROVAL_POLICIES_STORAGE_KEY, storedBlob);

    const renderer = await mountRow('forge');

    await flip(renderer, true);

    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockStore.get(APPROVAL_POLICIES_STORAGE_KEY)).toBe(storedBlob);
    renderer.unmount();
  });
});

// The writer's read distinguishes "no opt-ins" from "could not read": a missing
// key may be saved over, while any unreadable value must be left alone. The
// lenient loader the decision path uses still folds a refusal into {} so an
// unreadable store keeps asking.
describe('readApprovalPoliciesStrict', () => {
  beforeEach(() => {
    mockGetItem.mockReset();
  });

  it('answers an empty map for a missing key — genuinely empty, safe to save', async () => {
    mockGetItem.mockResolvedValueOnce(null);
    await expect(readApprovalPoliciesStrict()).resolves.toEqual({ ok: true, policies: {} });
  });

  it('keeps a present, valid map, including another Bot entry', async () => {
    const stored = {
      [approvalPolicyKey('gw', 'scout')]: { autoApproveRead: true },
      [approvalPolicyKey('gw', 'forge')]: { autoApproveRead: true },
    };
    mockGetItem.mockResolvedValueOnce(JSON.stringify(stored));
    await expect(readApprovalPoliciesStrict()).resolves.toEqual({ ok: true, policies: stored });
  });

  it('refuses a thrown read, corrupt json, and a value that is not a policy map', async () => {
    mockGetItem.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(readApprovalPoliciesStrict()).resolves.toEqual({ ok: false });

    mockGetItem.mockResolvedValueOnce('{not json');
    await expect(readApprovalPoliciesStrict()).resolves.toEqual({ ok: false });

    mockGetItem.mockResolvedValueOnce('');
    await expect(readApprovalPoliciesStrict()).resolves.toEqual({ ok: false });

    mockGetItem.mockResolvedValueOnce('[]');
    await expect(readApprovalPoliciesStrict()).resolves.toEqual({ ok: false });

    mockGetItem.mockResolvedValueOnce('null');
    await expect(readApprovalPoliciesStrict()).resolves.toEqual({ ok: false });

    mockGetItem.mockResolvedValueOnce('"opted-in"');
    await expect(readApprovalPoliciesStrict()).resolves.toEqual({ ok: false });
  });

  it('the lenient loader still answers {} so the decision fails closed to ask', async () => {
    mockGetItem.mockRejectedValueOnce(new Error('storage unavailable'));
    const refused = await loadApprovalPolicies();
    expect(refused).toEqual({});
    expect(
      approvalPolicyDecision({ policies: refused, gatewayId: 'gw', botId: 'scout', cls: 'read' }).decision,
    ).toBe('ask');

    mockGetItem.mockResolvedValueOnce('{not json');
    const corrupt = await loadApprovalPolicies();
    expect(corrupt).toEqual({});
    expect(
      approvalPolicyDecision({ policies: corrupt, gatewayId: 'gw', botId: 'scout', cls: 'read' }).decision,
    ).toBe('ask');
  });
});


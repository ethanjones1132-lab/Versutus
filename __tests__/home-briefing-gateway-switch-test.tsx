const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStore.delete(key); }),
  getAllKeys: jest.fn(async () => [...mockStore.keys()]),
  multiRemove: jest.fn(async () => undefined),
}));
jest.mock('@/components/ui', () => ({ Button: 'Button', Card: 'Card', Icon: 'Icon', PressableScale: 'PressableScale', Text: 'Text' }));
jest.mock('react-native-reanimated', () => ({ Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value } }));
const mockGateway = { activeGateway: { id: 'gw-1' } as { id: string } | null, runs: [] as ActivityRun[] };
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => ({ activeGateway: mockGateway.activeGateway, activityRunsForActiveGateway: mockGateway.runs }) }));
const mockFocus = { cleanup: null as null | (() => void), effect: null as null | (() => void | (() => void)) };
jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) => react.useEffect(() => {
      mockFocus.effect = effect;
      const cleanup = effect();
      mockFocus.cleanup = typeof cleanup === 'function' ? cleanup : null;
      return () => { mockFocus.cleanup?.(); };
    }, [effect]),
  };
});

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HomeBriefingCard } from '@/components/home-briefing-card';
import { LAST_SEEN_KEY_PREFIX } from '@/lib/home/last-seen';
import type { ActivityRun } from '@/lib/gateway/runs';

const TEXT = 'Text' as ElementType;
const STAMP = (id: string) => `${LAST_SEEN_KEY_PREFIX}${id}`;
const LEFT = 1_757_400_000_000;
const ARRIVAL = LEFT + 60_000;
function run(id: string): ActivityRun {
  return { id, prompt: 'do the thing', status: 'complete', startedAt: LEFT, finishedAt: LEFT + 30_000, events: [] };
}
function strings(): string[] {
  const walk = (node: unknown): string[] => {
    if (typeof node === 'string') return [node];
    if (Array.isArray(node)) return node.flatMap(walk);
    if (node && typeof node === 'object' && 'children' in node) return walk((node as { children: unknown }).children);
    return [];
  };
  return walk(renderer?.toJSON());
}
let renderer: ReactTestRenderer | null = null;
let resolveSecond!: (stamp: string | null) => void;

beforeEach(() => {
  mockStore.clear();
  mockGateway.activeGateway = { id: 'gw-1' };
  mockGateway.runs = [run('gw-1-run')];
  mockFocus.cleanup = null;
  jest.spyOn(Date, 'now').mockReturnValue(ARRIVAL);
});
afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => doomed.unmount());
  }
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('switching gateways hides the previous visit digest until the new stamp is read', async () => {
  mockStore.set(STAMP('gw-1'), String(LEFT));
  mockStore.set(STAMP('gw-2'), String(LEFT));
  const getItem = AsyncStorage.getItem as jest.Mock;
  getItem.mockImplementation((key: string) => {
    if (key === STAMP('gw-2')) return new Promise<string | null>((resolve) => { resolveSecond = resolve; });
    return Promise.resolve(mockStore.get(key) ?? null);
  });
  await act(async () => { renderer = create(createElement(HomeBriefingCard)); });
  expect(strings()).toContain('While you were away');

  mockGateway.activeGateway = { id: 'gw-2' };
  mockGateway.runs = [run('gw-2-run')];
  await act(async () => { renderer?.update(createElement(HomeBriefingCard)); });
  expect(renderer?.toJSON()).toBeNull();

  await act(async () => { resolveSecond(String(LEFT)); await Promise.resolve(); });
  expect(strings()).toContain('While you were away');
  expect(strings()).toContain('1 run finished');
});

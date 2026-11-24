jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  ErrorCard: 'ErrorCard',
  AppHeader: 'AppHeader',
  PageTitle: 'PageTitle',
  Screen: 'Screen',
  SegmentedControl: 'SegmentedControl',
  Text: 'Text',
}));
jest.mock('@/components/activity/today-section', () => ({ TodaySection: 'TodaySection' }));
jest.mock('@/components/activity/routines-section', () => ({ RoutinesSection: 'RoutinesSection' }));
jest.mock('@/components/nav/drawer-menu-button', () => ({ DrawerMenuButton: 'DrawerMenuButton' }));
jest.mock('@/components/connection-badge', () => ({ PulsingDot: 'PulsingDot' }));
jest.mock('@/lib/motion/ambient-parallax', () => ({
  useAmbientParallaxScroll: () => ({ parallaxY: 0, onScroll: () => undefined }),
}));
jest.mock('@/lib/motion/screen-edges', () => ({ screenEdgesFor: () => [] }));
jest.mock('@/lib/motion/tab-insets', () => ({ tabContentPaddingBottom: () => 0 }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#7353ba',
    backgroundElevated: '#fff',
    statusConnected: '#39855f',
    textTertiary: '#888',
  }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockRefreshPendingApprovals = jest.fn<Promise<void>, []>();
const mockGateway = {
  activeGateway: { id: 'gw-1', name: 'Alpha', url: 'http://alpha.test:8642' },
  status: 'connected',
  requestRunFocus: jest.fn(),
  selectSession: jest.fn(),
  refreshPendingApprovals: () => mockRefreshPendingApprovals(),
};
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

import { createElement, type ElementType } from 'react';
import { RefreshControl } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import ActivityScreen from '@/app/(tabs)/activity';

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ActivityScreen));
  });
}

function node(type: string) {
  return renderer?.root.findAllByType(type as ElementType)[0];
}

async function refresh(): Promise<void> {
  const control = renderer?.root.findByType(RefreshControl);
  expect(control).toBeDefined();
  await act(async () => {
    control?.props.onRefresh();
    await jest.advanceTimersByTimeAsync(500);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockRefreshPendingApprovals.mockReset();
  mockRefreshPendingApprovals.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => doomed.unmount());
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('Activity waits for approvals before reloading the selected Today or Routines view', async () => {
  await mount();
  expect(node('TodaySection')?.props.reloadSignal).toBe(0);
  expect(node('RoutinesSection')).toBeUndefined();

  const pending = deferred();
  mockRefreshPendingApprovals.mockReturnValueOnce(pending.promise);
  await act(async () => {
    renderer?.root.findByType(RefreshControl).props.onRefresh();
    await Promise.resolve();
  });
  expect(mockRefreshPendingApprovals).toHaveBeenCalledTimes(1);
  expect(node('TodaySection')?.props.reloadSignal).toBe(0);

  await act(async () => {
    pending.resolve();
    await pending.promise;
    await jest.advanceTimersByTimeAsync(500);
  });
  expect(node('TodaySection')?.props.reloadSignal).toBe(1);

  await act(async () => {
    node('SegmentedControl')?.props.onSelect('routines');
  });
  expect(node('TodaySection')).toBeUndefined();
  expect(node('RoutinesSection')?.props.reloadSignal).toBe(1);

  await refresh();
  expect(mockRefreshPendingApprovals).toHaveBeenCalledTimes(2);
  expect(node('RoutinesSection')?.props.reloadSignal).toBe(2);
});

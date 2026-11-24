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
  activeGateway: { id: 'gw-alpha', name: 'Alpha', url: 'http://alpha.test:8642' },
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

type ErrorCardProps = {
  cause?: string;
  affected?: string;
  next?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
};

let renderer: ReactTestRenderer | null = null;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ActivityScreen));
  });
}

function first(type: string) {
  return renderer?.root.findAllByType(type as ElementType)[0];
}

function refreshError(): ErrorCardProps | undefined {
  return first('ErrorCard')?.props as ErrorCardProps | undefined;
}

async function pull(): Promise<void> {
  await act(async () => {
    renderer?.root.findByType(RefreshControl).props.onRefresh();
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

test('a failed approvals refresh is named honestly and its Retry repeats the refresh', async () => {
  mockRefreshPendingApprovals.mockRejectedValueOnce(new Error('gateway timed out'));
  await mount();
  await pull();

  expect(refreshError()).toMatchObject({
    cause: 'gateway timed out',
    affected: "Activity's approvals inbox",
    next: 'Retry the refresh.',
  });
  expect(refreshError()?.onRetry).toBeDefined();
  expect(refreshError()?.onDismiss).toBeDefined();
  expect(mockRefreshPendingApprovals).toHaveBeenCalledTimes(1);

  await act(async () => {
    refreshError()?.onRetry?.();
    await jest.advanceTimersByTimeAsync(500);
  });

  expect(mockRefreshPendingApprovals).toHaveBeenCalledTimes(2);
  expect(refreshError()).toBeUndefined();
});

test('Activity contains Today and Routines without the retired legacy sections', async () => {
  await mount();

  expect(first('TodaySection')).toBeDefined();
  expect(first('RoutinesSection')).toBeUndefined();
  const segmented = first('SegmentedControl');
  expect(segmented?.props.options).toEqual([
    { key: 'today', label: 'Today' },
    { key: 'routines', label: 'Routines' },
  ]);
  for (const legacy of ['AgentTargets', 'ActivityGlance', 'CronSection', 'SpendEntryRow', 'ScorecardsSection']) {
    expect(renderer?.root.findAllByType(legacy as ElementType)).toHaveLength(0);
  }

  await act(async () => segmented?.props.onSelect('routines'));
  expect(first('TodaySection')).toBeUndefined();
  expect(first('RoutinesSection')).toBeDefined();
});

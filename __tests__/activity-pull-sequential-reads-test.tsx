// One pull-to-refresh on Activity used to fan out: `Promise.all` over the
// capabilities refresh, the local gateway roster and the pending-approvals RPC,
// all in flight at once, against a host the repo documents as serving one
// request at a time. It then bumped the cron reload signal, which re-ran the
// section's mount effect — an extra `cron.list()` on top of the read focus had
// already issued. These pin the sequential order and one read of each thing.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  // CronSection is real here: the pull's cron reload goes through its own
  // coalesced loader, which is half of what this test is about.
  Badge: 'Badge',
  Button: 'Button',
  Card: 'Card',
  EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  ListRow: 'ListRow',
  PageTitle: 'PageTitle',
  Screen: 'Screen',
  SectionHeader: 'SectionHeader',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/components/activity/cron-job-sheet', () => ({ CronJobSheet: 'CronJobSheet' }));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));

jest.mock('@/components/nav/drawer-menu-button', () => ({ DrawerMenuButton: 'DrawerMenuButton' }));
jest.mock('@/components/connection-badge', () => ({ PulsingDot: 'PulsingDot' }));
jest.mock('@/components/activity/activity-glance', () => ({ ActivityGlance: 'ActivityGlance' }));
jest.mock('@/components/activity/agent-targets', () => ({ AgentTargets: 'AgentTargets' }));
jest.mock('@/components/activity/approval-decision-card', () => ({ ApprovalDecisionCard: 'ApprovalDecisionCard' }));
jest.mock('@/components/activity/approval-inbox', () => ({ ApprovalInbox: 'ApprovalInbox' }));
jest.mock('@/components/activity/recent-runs', () => ({ RecentRuns: 'RecentRuns' }));
jest.mock('@/components/gateway/spend-entry-row', () => ({ SpendEntryRow: 'SpendEntryRow' }));

jest.mock('expo-router', () => {
  // Real semantics: the effect runs on the first focus, which is the cron
  // read the pull is measured against.
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: () => undefined }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      useEffect(() => effect(), [effect]);
    },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/lib/motion/ambient-parallax', () => ({
  useAmbientParallaxScroll: () => ({ parallaxY: 0, onScroll: () => undefined }),
}));

jest.mock('@/lib/notifications/routine-sync', () => ({
  syncRoutineNotification: jest.fn(async () => undefined),
  cancelRoutineNotification: jest.fn(async () => undefined),
  rearmRoutineNotifications: jest.fn(async () => undefined),
}));

/** Every read the pull issued, as `name:start` / `name:end` markers. */
const mockTrace: string[] = [];
let mockCronReads = 0;

function step<T>(name: string, answer: () => T): Promise<T> {
  mockTrace.push(`${name}:start`);
  return Promise.resolve().then(() => {
    mockTrace.push(`${name}:end`);
    return answer();
  });
}

const mockGateway = {
  activeGateway: { id: 'gw-1', name: 'Alpha', url: 'http://alpha.test:8642' },
  activityRunsForActiveGateway: [],
  gateways: [],
  settings: { pcName: 'Alpha' },
  status: 'connected',
  pendingRunApproval: null,
  pendingApprovals: [],
  requestRunFocus: () => undefined,
  resolveRunApproval: () => undefined,
  refreshPendingApprovals: () => step('approvals', () => undefined),
  connectGateway: () => undefined,
  refreshCapabilities: () => step('capabilities', () => undefined),
  refreshGateways: () => step('gateways', () => undefined),
  cron: {
    available: true,
    list: () => {
      mockCronReads += 1;
      return Promise.resolve([{ id: 'job-1', title: 'Job one' }]);
    },
  },
  botJobs: { create: jest.fn(async () => ({ id: 'job-new' })) },
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

import { createElement } from 'react';
import { RefreshControl } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import ActivityScreen from '@/app/(tabs)/activity';

let renderer: ReactTestRenderer | null = null;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ActivityScreen));
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

async function pull(): Promise<void> {
  const control = renderer?.root.findByType(RefreshControl);
  expect(control).toBeDefined();
  await act(async () => {
    await control?.props.onRefresh();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockTrace.length = 0;
  mockCronReads = 0;
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('a pull reads the approvals, then the capabilities, then the roster — one at a time', async () => {
  await mount();
  mockTrace.length = 0;

  await pull();

  // Sequential, in the order the tab is actually read: a fan-out here sent all
  // three to a Gate that serves one request at a time.
  expect(mockTrace).toEqual([
    'approvals:start',
    'approvals:end',
    'capabilities:start',
    'capabilities:end',
    'gateways:start',
    'gateways:end',
  ]);
});

test('a pull reads the cron roster once and the pending approvals once', async () => {
  await mount();
  // The focus read the section already issued on arrival.
  expect(mockCronReads).toBe(1);

  await pull();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });

  // The reload signal reaches the section's own coalesced loader, so the pull
  // adds exactly one cron.list() — not a second one beside the focus read.
  expect(mockCronReads).toBe(2);
  expect(mockTrace.filter((entry) => entry === 'approvals:start')).toHaveLength(1);
});

test('the spinner ends when the work ends', async () => {
  await mount();

  await pull();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(400);
  });

  const control = renderer?.root.findByType(RefreshControl);
  expect(control?.props.refreshing).toBe(false);
});
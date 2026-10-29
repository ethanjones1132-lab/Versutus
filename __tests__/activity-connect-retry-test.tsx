// VS-004: a connect the Gate refused was written into `refreshError`, so the
// screen said "Activity's gateway reads" / "Retry the refresh." — and Retry ran
// `onRefresh`, which re-reads capabilities and the roster but never calls
// `connectGateway`. The one action the notice told the operator to take could
// not recover the connection. These mount the real ActivityScreen and pin:
// a refused selection is its own notice naming that gateway; Retry repeats
// `connectGateway` with the same profile and runs no read; a second refusal is
// caught and stays recoverable; success and Dismiss clear only the connection
// notice; a superseded attempt may neither overwrite nor clear a newer refusal;
// and two Retry taps inside one frame are one connect.

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

jest.mock('@/components/activity/cron-section', () => ({ CronSection: 'CronSection' }));
jest.mock('@/components/activity/cron-job-sheet', () => ({ CronJobSheet: 'CronJobSheet' }));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));

jest.mock('@/components/nav/drawer-menu-button', () => ({ DrawerMenuButton: 'DrawerMenuButton' }));
jest.mock('@/components/connection-badge', () => ({ PulsingDot: 'PulsingDot' }));
jest.mock('@/components/activity/activity-glance', () => ({ ActivityGlance: 'ActivityGlance' }));
// The switcher's own row contract is pinned elsewhere; here the leaf is a
// string so the test can hand the screen the tap AgentTargets would make.
jest.mock('@/components/activity/agent-targets', () => ({ AgentTargets: 'AgentTargets' }));
jest.mock('@/components/activity/approval-decision-card', () => ({ ApprovalDecisionCard: 'ApprovalDecisionCard' }));
jest.mock('@/components/activity/approval-inbox', () => ({ ApprovalInbox: 'ApprovalInbox' }));
jest.mock('@/components/activity/recent-runs', () => ({ RecentRuns: 'RecentRuns' }));
jest.mock('@/components/gateway/spend-entry-row', () => ({ SpendEntryRow: 'SpendEntryRow' }));

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: (...args: unknown[]) => mockPush(...args) }),
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

const mockPush = jest.fn();
const mockConnectGateway = jest.fn();
const mockRefreshPendingApprovals = jest.fn();
const mockRefreshCapabilities = jest.fn();
const mockRefreshGateways = jest.fn();

const alpha: GatewayProfile = {
  id: 'gw-alpha',
  name: 'Alpha',
  url: 'http://alpha.test:8642',
  createdAt: 0,
};
const beta: GatewayProfile = {
  id: 'gw-beta',
  name: 'Beta',
  url: 'http://beta.test:8642',
  createdAt: 0,
};

const mockGateway = {
  activeGateway: alpha,
  activityRunsForActiveGateway: [],
  gateways: [alpha, beta],
  settings: { pcName: 'Alpha' },
  status: 'disconnected',
  pendingRunApproval: null,
  pendingApprovals: [],
  requestRunFocus: () => undefined,
  resolveRunApproval: () => undefined,
  refreshPendingApprovals: () => mockRefreshPendingApprovals(),
  connectGateway: (gateway: GatewayProfile) => mockConnectGateway(gateway) as Promise<void>,
  refreshCapabilities: () => mockRefreshCapabilities(),
  refreshGateways: () => mockRefreshGateways(),
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

import { createElement, type ElementType } from 'react';
import { RefreshControl } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import ActivityScreen from '@/app/(tabs)/activity';
import type { GatewayProfile } from '@/lib/gateway/types';

type CardProps = {
  cause?: string;
  affected?: string;
  next?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
};

let renderer: ReactTestRenderer | null = null;

/** A promise whose settle this test decides, for two attempts in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ActivityScreen));
  });
  await flush();
}

/** The tap AgentTargets makes: it hands the screen the tapped profile. */
async function select(gateway: GatewayProfile): Promise<void> {
  const targets = renderer?.root.findByType('AgentTargets' as ElementType);
  expect(targets).toBeDefined();
  await act(async () => {
    targets?.props.onSelect(gateway);
  });
  await flush();
}

async function pullToRefresh(): Promise<void> {
  const control = renderer?.root.findByType(RefreshControl);
  expect(control).toBeDefined();
  // The pull's own 400 ms spinner hold is part of the work, so run it out.
  await act(async () => {
    control?.props.onRefresh();
    await jest.advanceTimersByTimeAsync(600);
  });
}

function errorCards(): CardProps[] {
  return (
    renderer?.root.findAllByType('ErrorCard' as ElementType).map((node) => node.props as CardProps) ?? []
  );
}

/** The connection notice: the one that names the gateway it failed to reach. */
function connectionCard(): CardProps | undefined {
  return errorCards().find((card) => String(card.affected ?? '').startsWith('Connection to'));
}

/** The refresh notice: the screen's own failed gateway reads. */
function refreshCard(): CardProps | undefined {
  return errorCards().find((card) => card.affected === "Activity's gateway reads");
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockConnectGateway.mockResolvedValue(undefined);
  mockRefreshPendingApprovals.mockResolvedValue(undefined);
  mockRefreshCapabilities.mockResolvedValue(undefined);
  mockRefreshGateways.mockResolvedValue(undefined);
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

test('a refused selection is named as a connection failure, not a failed refresh', async () => {
  mockConnectGateway.mockRejectedValueOnce(new Error('gateway rejected the API key'));
  await mount();

  await select(alpha);

  // The tap still connects the profile it was handed, once.
  expect(mockConnectGateway).toHaveBeenCalledTimes(1);
  expect(mockConnectGateway.mock.calls[0][0]).toBe(alpha);

  const card = connectionCard();
  expect(card).toBeDefined();
  expect(card?.cause).toBe('gateway rejected the API key');
  expect(card?.affected).toBe('Connection to Alpha');
  expect(card?.next).toBe('Retry the connection.');
  expect(card?.onRetry).toBeDefined();
  expect(card?.onDismiss).toBeDefined();
  // Not the refresh's notice: nothing about this failure is a stale read.
  expect(refreshCard()).toBeUndefined();
  expect(mockRefreshPendingApprovals).not.toHaveBeenCalled();
  expect(mockRefreshCapabilities).not.toHaveBeenCalled();
  expect(mockRefreshGateways).not.toHaveBeenCalled();
  // The switcher still stays on Activity.
  expect(mockPush).not.toHaveBeenCalled();
});

test('Retry repeats connectGateway with the same profile and runs no refresh', async () => {
  mockConnectGateway.mockRejectedValueOnce(new Error('refused'));
  await mount();
  await select(alpha);

  const retry = connectionCard()?.onRetry;
  expect(retry).toBeDefined();
  mockConnectGateway.mockClear();
  mockRefreshPendingApprovals.mockClear();
  mockRefreshCapabilities.mockClear();
  mockRefreshGateways.mockClear();
  mockPush.mockClear();

  await act(async () => {
    retry?.();
  });
  await flush();

  // The refused action itself, for the exact profile that was refused.
  expect(mockConnectGateway).toHaveBeenCalledTimes(1);
  expect(mockConnectGateway.mock.calls[0][0]).toBe(alpha);
  // A refresh re-reads gateway state; it can never reconnect.
  expect(mockRefreshPendingApprovals).not.toHaveBeenCalled();
  expect(mockRefreshCapabilities).not.toHaveBeenCalled();
  expect(mockRefreshGateways).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  // Success leaves no connection notice behind.
  expect(connectionCard()).toBeUndefined();
});

test('a retry the Gate refuses again stays recoverable', async () => {
  mockConnectGateway.mockRejectedValueOnce(new Error('refused once'));
  await mount();
  await select(alpha);

  mockConnectGateway.mockRejectedValueOnce(new Error('refused again'));
  await act(async () => {
    connectionCard()?.onRetry?.();
  });
  await flush();

  const card = connectionCard();
  expect(card?.cause).toBe('refused again');
  expect(card?.affected).toBe('Connection to Alpha');
  expect(card?.onRetry).toBeDefined();
  expect(card?.onDismiss).toBeDefined();

  // Still recoverable: a third attempt can succeed.
  mockConnectGateway.mockResolvedValueOnce(undefined);
  await act(async () => {
    connectionCard()?.onRetry?.();
  });
  await flush();
  expect(mockConnectGateway).toHaveBeenCalledTimes(3);
  expect(connectionCard()).toBeUndefined();
});

test('a successful retry clears only the connection notice, not an independent refresh failure', async () => {
  mockRefreshPendingApprovals.mockRejectedValueOnce(new Error('gateway timed out'));
  await mount();
  await pullToRefresh();
  expect(refreshCard()?.cause).toBe('gateway timed out');

  mockConnectGateway.mockRejectedValueOnce(new Error('refused'));
  await select(alpha);
  expect(connectionCard()?.affected).toBe('Connection to Alpha');

  mockConnectGateway.mockResolvedValueOnce(undefined);
  await act(async () => {
    connectionCard()?.onRetry?.();
  });
  await flush();

  expect(connectionCard()).toBeUndefined();
  // The refresh read is a separate failure; the connect never owned it.
  expect(refreshCard()?.cause).toBe('gateway timed out');
  expect(refreshCard()?.next).toBe('Retry the refresh.');
});

test('Dismiss clears the connection notice and leaves the refresh failure alone', async () => {
  mockRefreshPendingApprovals.mockRejectedValueOnce(new Error('gateway timed out'));
  await mount();
  await pullToRefresh();
  expect(refreshCard()).toBeDefined();

  mockConnectGateway.mockRejectedValueOnce(new Error('refused'));
  await select(alpha);
  expect(connectionCard()).toBeDefined();

  await act(async () => {
    connectionCard()?.onDismiss?.();
  });
  await flush();

  expect(connectionCard()).toBeUndefined();
  expect(refreshCard()?.cause).toBe('gateway timed out');
});

test('a superseded attempt that fails late cannot overwrite the newer selection', async () => {
  const first = deferred();
  const second = deferred();
  mockConnectGateway.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await mount();

  await select(alpha);
  await select(beta);
  expect(mockConnectGateway).toHaveBeenCalledTimes(2);

  await act(async () => {
    second.reject(new Error('beta refused'));
  });
  await flush();
  expect(connectionCard()?.affected).toBe('Connection to Beta');

  // Alpha's attempt settles afterwards: the newer refusal is the truth.
  await act(async () => {
    first.reject(new Error('alpha refused'));
  });
  await flush();
  expect(connectionCard()?.affected).toBe('Connection to Beta');
  expect(connectionCard()?.cause).toBe('beta refused');
});

test('a retry that completes after a newer selection failed cannot clear that refusal', async () => {
  mockConnectGateway.mockRejectedValueOnce(new Error('refused'));
  await mount();
  await select(alpha);

  const retry = deferred();
  mockConnectGateway.mockReturnValueOnce(retry.promise);
  await act(async () => {
    connectionCard()?.onRetry?.();
  });
  await flush();
  // The retry is in flight; the card still names the connect being repeated.
  expect(connectionCard()?.affected).toBe('Connection to Alpha');
  expect(mockConnectGateway).toHaveBeenCalledTimes(2);

  const newer = deferred();
  mockConnectGateway.mockReturnValueOnce(newer.promise);
  await select(beta);
  await act(async () => {
    newer.reject(new Error('beta refused'));
  });
  await flush();
  expect(connectionCard()?.affected).toBe('Connection to Beta');

  // The older retry answering now must not wipe the newer refusal.
  await act(async () => {
    retry.resolve();
  });
  await flush();
  expect(connectionCard()?.affected).toBe('Connection to Beta');
  expect(connectionCard()?.cause).toBe('beta refused');
});

test('two Retry taps inside one frame put one connect on the host', async () => {
  mockConnectGateway.mockRejectedValueOnce(new Error('refused'));
  await mount();
  await select(alpha);

  const retry = deferred();
  mockConnectGateway.mockReturnValueOnce(retry.promise);
  const pressRetry = connectionCard()?.onRetry;
  expect(pressRetry).toBeDefined();

  // Both presses come off the same rendered closure, before any re-render.
  await act(async () => {
    pressRetry?.();
    pressRetry?.();
  });
  await flush();

  // One for the selection, one for the retry — the duplicate press is dropped.
  expect(mockConnectGateway).toHaveBeenCalledTimes(2);
  expect(mockConnectGateway.mock.calls[1][0]).toBe(alpha);
  // The card stays up for the attempt it is repeating.
  expect(connectionCard()?.affected).toBe('Connection to Alpha');

  await act(async () => {
    retry.reject(new Error('refused again'));
  });
  await flush();
  expect(connectionCard()?.cause).toBe('refused again');

  // The guard released, so the card's Retry still works.
  mockConnectGateway.mockResolvedValueOnce(undefined);
  await act(async () => {
    connectionCard()?.onRetry?.();
  });
  await flush();
  expect(mockConnectGateway).toHaveBeenCalledTimes(3);
  expect(connectionCard()).toBeUndefined();
});

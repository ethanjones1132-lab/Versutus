import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TodaySection } from '@/components/activity/today-section';
import type { ActivityFeed } from '@/lib/gateway/activity-feed';

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  Card: 'Card',
  Chip: 'Chip',
  ErrorCard: 'ErrorCard',
  SectionHeader: 'SectionHeader',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));
jest.mock('@/components/activity/activity-row', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return {
    ActivityRow: (props: Record<string, unknown>) => createElement('ActivityRow', props),
  };
});
jest.mock('@/components/activity/approval-decision-card', () => ({ ApprovalDecisionCard: 'ApprovalDecisionCard' }));
jest.mock('@/components/activity/approval-inbox', () => ({ ApprovalInbox: 'ApprovalInbox' }));
jest.mock('@/components/activity/recent-runs', () => ({ RecentRuns: 'RecentRuns' }));
jest.mock('@/components/ui/ListRow', () => ({ ListRow: 'ListRow' }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#a0f',
    statusConnecting: '#fc0',
    statusDisconnected: '#f00',
    statusConnected: '#0f0',
  }),
}));

const mockGateway = {
  activeGateway: { id: 'gw-a', name: 'Alpha', url: 'http://alpha.test:8642' } as
    | { id: string; name: string; url: string }
    | undefined,
  status: 'connected',
  activityRunsForActiveGateway: [],
  pendingApprovals: [],
  pendingRunApproval: null,
  resolveRunApproval: () => undefined,
  listBots: jest.fn(async () => []),
  activityFeed: {
    readActivity: jest.fn(),
    readRoutines: jest.fn(),
  },
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

function feed(since: string, title: string, backendId = 'backend-a'): ActivityFeed {
  return {
    since,
    generatedAt: '2026-11-10T12:00:00.000Z',
    backends: [{ id: backendId, label: backendId, status: 'complete' }],
    items: [{
      id: `${backendId}:session:1`,
      backendId,
      kind: 'session',
      sessionId: 's-1',
      startedAt: '2026-11-10T10:00:00.000Z',
      status: 'complete',
      title,
      metrics: {},
    }],
  };
}

function deferredFeed(): { promise: Promise<ActivityFeed>; resolve: (value: ActivityFeed) => void } {
  let resolve!: (value: ActivityFeed) => void;
  const promise = new Promise<ActivityFeed>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function emptyFeed(since: string): ActivityFeed {
  return { since, generatedAt: '2026-11-10T12:00:00.000Z', backends: [], items: [] };
}

let renderer: ReactTestRenderer | null = null;

function mount(): void {
  act(() => {
    renderer = create(<TodaySection reloadSignal={0} onOpenRun={() => undefined} onOpenSession={() => undefined} />);
  });
}

async function flush(ms = 1): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function rowTitles(): string[] {
  if (!renderer) return [];
  return renderer.root
    .findAllByType('ActivityRow' as never)
    .map((node) => (node.props as { item: { title: string } }).item.title);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGateway.activeGateway = { id: 'gw-a', name: 'Alpha', url: 'http://alpha.test:8642' };
  mockGateway.status = 'connected';
  mockGateway.listBots.mockClear();
  mockGateway.activityFeed.readActivity.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("Today's read belongs to the Gate on screen", () => {
  test('a switch does not show the previous Gate feed and starts its own read', async () => {
    const fromA = deferredFeed();
    mockGateway.activityFeed.readActivity
      .mockReturnValueOnce(fromA.promise)
      .mockResolvedValueOnce(feed('2026-11-10T00:00:00.000Z', 'B thread', 'backend-b'));

    mount();
    await flush();
    expect(mockGateway.activityFeed.readActivity).toHaveBeenCalledTimes(1);

    mockGateway.activeGateway = { id: 'gw-b', name: 'Beta', url: 'http://beta.test:8642' };
    act(() => {
      renderer!.update(
        <TodaySection reloadSignal={0} onOpenRun={() => undefined} onOpenSession={() => undefined} />,
      );
    });
    // The B read must be a new request, not the A one still open.
    await flush();
    expect(mockGateway.activityFeed.readActivity).toHaveBeenCalledTimes(2);
    expect(rowTitles()).toEqual(['B thread']);

    // The deferred A answer lands after the switch. It must neither paint
    // under B nor count as the answer to B's read.
    act(() => {
      fromA.resolve(feed('2026-11-10T00:00:00.000Z', 'A thread', 'backend-a'));
    });
    await flush();
    expect(rowTitles()).toEqual(['B thread']);
  });
});

describe('Today re-reads when the day or the foreground changes', () => {
  test('crossing local midnight reads again with the new day boundary', async () => {
    jest.setSystemTime(new Date(2026, 10, 10, 23, 59, 50));
    mockGateway.activityFeed.readActivity.mockImplementation(async ({ since }: { since: string }) => emptyFeed(since));

    mount();
    await flush();
    expect(mockGateway.activityFeed.readActivity.mock.calls[0][0].since).toBe(
      new Date(2026, 10, 10).toISOString(),
    );

    // 20s later the local day has rolled over; the one midnight timer fires.
    await flush(20_000);
    // The new boundary re-renders, and the read it schedules runs on the next tick.
    await flush();
    const last = mockGateway.activityFeed.readActivity.mock.calls.at(-1)?.[0] as { since: string };
    expect(mockGateway.activityFeed.readActivity).toHaveBeenCalledTimes(2);
    expect(last.since).toBe(new Date(2026, 10, 11).toISOString());
  });

  test('returning to the foreground reads again with the new day boundary', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      listener: (state: AppStateStatus) => void,
    ) => {
      listeners.push(listener);
      return { remove: () => undefined };
    }) as unknown as typeof AppState.addEventListener);

    jest.setSystemTime(new Date(2026, 10, 10, 12));
    mockGateway.activityFeed.readActivity.mockImplementation(async ({ since }: { since: string }) => emptyFeed(since));

    mount();
    await flush();
    expect(mockGateway.activityFeed.readActivity.mock.calls[0][0].since).toBe(
      new Date(2026, 10, 10).toISOString(),
    );

    jest.setSystemTime(new Date(2026, 10, 11, 9));
    act(() => {
      for (const listener of listeners) listener('active');
    });
    await flush();

    const last = mockGateway.activityFeed.readActivity.mock.calls.at(-1)?.[0] as { since: string };
    expect(mockGateway.activityFeed.readActivity).toHaveBeenCalledTimes(2);
    expect(last.since).toBe(new Date(2026, 10, 11).toISOString());
  });

  test('a same-day foreground return still refreshes without inventing a new boundary', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      listener: (state: AppStateStatus) => void,
    ) => {
      listeners.push(listener);
      return { remove: () => undefined };
    }) as unknown as typeof AppState.addEventListener);

    jest.setSystemTime(new Date(2026, 10, 10, 12));
    mockGateway.activityFeed.readActivity.mockImplementation(async ({ since }: { since: string }) => emptyFeed(since));

    mount();
    await flush();
    expect(mockGateway.activityFeed.readActivity).toHaveBeenCalledTimes(1);

    act(() => {
      for (const listener of listeners) listener('active');
    });
    await flush();

    expect(mockGateway.activityFeed.readActivity).toHaveBeenCalledTimes(2);
    expect(mockGateway.activityFeed.readActivity.mock.calls[1][0].since).toBe(
      new Date(2026, 10, 10).toISOString(),
    );
  });
});

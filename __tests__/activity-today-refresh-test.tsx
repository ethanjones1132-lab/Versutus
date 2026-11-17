import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TodaySection } from '@/components/activity/today-section';
import { sinceMidnightAnchor } from '@/lib/activity/today';
import type { ApprovalRow } from '@/lib/gateway/approvals';
import type { ActivityFeed } from '@/lib/gateway/activity-feed';
import type { ActivityRun } from '@/lib/gateway/runs';

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
  activityRunsForActiveGateway: [] as ActivityRun[],
  pendingApprovals: [] as ApprovalRow[],
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

function visibleText(): string[] {
  if (!renderer) return [];
  return renderer.root.findAllByType('Text' as never).flatMap((node) => {
    const value = (node.props as { children?: unknown }).children;
    return typeof value === 'string' ? [value] : [];
  });
}

function sectionTitles(): string[] {
  if (!renderer) return [];
  return renderer.root
    .findAllByType('SectionHeader' as never)
    .map((node) => (node.props as { title: string }).title);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGateway.activeGateway = { id: 'gw-a', name: 'Alpha', url: 'http://alpha.test:8642' };
  mockGateway.status = 'connected';
  mockGateway.activityRunsForActiveGateway = [];
  mockGateway.pendingApprovals = [];
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

describe('Today keeps its empty and stale copy honest', () => {
  test('does not call a failed backend an empty day', async () => {
    mockGateway.activityFeed.readActivity.mockResolvedValue({
      since: new Date(2026, 10, 14).toISOString(),
      generatedAt: '2026-11-14T12:00:00.000Z',
      backends: [{ id: 'hermes', label: 'Hermes', status: 'failed', error: 'read timed out' }],
      items: [],
    } satisfies ActivityFeed);

    mount();
    await flush();

    expect(visibleText()).not.toContain('Nothing since midnight.');
    expect(visibleText().some((line) => line.startsWith('Since midnight ·'))).toBe(false);
    expect(visibleText()).toContain("Hermes: This backend's activity could not be read");
  });

  test('renders the count and stale-read separators as real Unicode punctuation', async () => {
    jest.setSystemTime(new Date(2026, 10, 14, 12));
    const since = new Date(2026, 10, 14).toISOString();
    mockGateway.activityFeed.readActivity
      .mockResolvedValueOnce(feed(since, 'A session'))
      .mockRejectedValueOnce(new Error('gateway read timed out'));

    mount();
    await flush();
    expect(visibleText()).toContain('0 runs · 1 session');
    expect(visibleText()).toContain(sinceMidnightAnchor(since));

    act(() => {
      renderer!.update(
        <TodaySection reloadSignal={1} onOpenRun={() => undefined} onOpenSession={() => undefined} />,
      );
    });
    await flush();
    expect(visibleText()).toContain('Could not refresh — showing the last read.');

    mockGateway.status = 'disconnected';
    act(() => {
      renderer!.update(
        <TodaySection reloadSignal={1} onOpenRun={() => undefined} onOpenSession={() => undefined} />,
      );
    });
    await flush();
    expect(visibleText().some((line) => line.includes(' · Older than today'))).toBe(true);
  });
});

describe('Today says which day, and which scope, its rows belong to', () => {
  test('a failed post-midnight re-read keeps the anchor on the day its rows were read', async () => {
    jest.setSystemTime(new Date(2026, 10, 10, 23, 59, 50));
    const yesterday = new Date(2026, 10, 10).toISOString();
    mockGateway.activityFeed.readActivity
      .mockResolvedValueOnce(feed(yesterday, 'A session'))
      .mockRejectedValueOnce(new Error('gateway read timed out'));

    mount();
    await flush();
    expect(visibleText()).toContain(sinceMidnightAnchor(yesterday));

    // The day rolls over and the re-read fails, so the previous feed stays on
    // screen: its anchor must stay on that feed's boundary, not today's.
    await flush(20_000);
    await flush();
    expect(mockGateway.activityFeed.readActivity).toHaveBeenCalledTimes(2);
    expect(visibleText()).toContain(sinceMidnightAnchor(yesterday));
    expect(visibleText()).not.toContain(sinceMidnightAnchor(new Date(2026, 10, 11).toISOString()));
  });

  test('a selected chip says the live runs and the need-you count cover every backend', async () => {
    jest.setSystemTime(new Date(2026, 10, 10, 12));
    const since = new Date(2026, 10, 10).toISOString();
    const session = (backendId: string, title: string) => ({
      id: `${backendId}:session:1`,
      backendId,
      kind: 'session' as const,
      sessionId: `${backendId}-s-1`,
      startedAt: '2026-11-10T10:00:00.000Z',
      status: 'complete' as const,
      title,
      metrics: {},
    });
    mockGateway.activityFeed.readActivity.mockResolvedValue({
      since,
      generatedAt: '2026-11-10T12:00:00.000Z',
      backends: [
        { id: 'backend-a', label: 'Alpha', status: 'complete' },
        { id: 'backend-b', label: 'Beta', status: 'complete' },
      ],
      items: [session('backend-a', 'A session'), session('backend-b', 'B session')],
    } satisfies ActivityFeed);
    mockGateway.activityRunsForActiveGateway = [{
      id: 'run-1',
      prompt: 'Still going',
      status: 'running',
      startedAt: new Date(2026, 10, 10, 11).getTime(),
      events: [],
    }];
    mockGateway.pendingApprovals = [
      { approvalId: 'ap-1', cls: 'read' },
      { approvalId: 'ap-2', cls: 'workspace_write' },
    ];

    mount();
    await flush();
    // Unfiltered, the copy makes no claim about scope.
    expect(rowTitles()).toEqual(['A session', 'B session']);
    expect(visibleText()).not.toContain('Covers every backend, not just this one.');

    const chip = renderer!.root
      .findAllByType('Chip' as never)
      .find((node) => (node.props as { label?: string }).label === 'Alpha');
    expect(chip).toBeDefined();
    act(() => { (chip!.props as { onPress: () => void }).onPress(); });
    await flush();

    // Feed rows obey the chip; the live runs and the count cannot, and say so.
    expect(rowTitles()).toEqual(['A session']);
    expect(sectionTitles()).toContain('In progress');
    expect(visibleText()).toContain('Covers every backend, not just this one.');
    expect(visibleText().some((line) => line.includes('2 need you on every backend'))).toBe(true);
  });
});

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { RoutinesSection } from '@/components/activity/routines-section';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { RoutineFeed } from '@/lib/gateway/activity-feed';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

// A routine read from Activity carries the backend that owns it. Today every
// sheet action resolves on the Gate's default environment, so a routine on a
// second Hermes backend answers "not found" to Run now, Pause and Remove. The
// row's backend must travel with each action and with its run history.

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/lib/haptics', () => ({ haptics: { success: jest.fn(async () => undefined) } }));
jest.mock('@/lib/notifications/routine-sync', () => ({
  syncRoutineNotification: jest.fn(async () => undefined),
  cancelRoutineNotification: jest.fn(async () => undefined),
}));
jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Button: 'Button',
  Card: 'Card',
  Chip: 'Chip',
  ConfirmSheet: 'ConfirmSheet',
  Divider: 'Divider',
  ErrorCard: 'ErrorCard',
  ListRow: 'ListRow',
  SectionHeader: 'SectionHeader',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));

const mockGateway = {
  activeGateway: { id: 'gw-a', name: 'Alpha', url: 'http://alpha.test:8642' },
  status: 'connected',
  activityFeed: { readActivity: jest.fn(), readRoutines: jest.fn() },
  botJobs: { run: jest.fn(), pause: jest.fn(), remove: jest.fn() },
  cron: { available: true, runs: jest.fn(async () => []) },
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

const PROFILE: GatewayProfile = {
  id: 'gate-routines',
  name: 'Routines Gate',
  url: 'http://gate.test:8760',
  token: 'k',
  createdAt: 0,
};

const IDENTITY = {
  kind: 'custom',
  kindLabel: 'Versutus Gate',
  source: 'manifest',
  identifiedAt: 0,
  auth: { schemes: ['bearer'], requiresToken: true },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Routines Gate',
    endpoints: {
      health: '/health',
      jobs: '/v1/jobs',
      capabilitiesRpc: '/v1/capabilities/rpc',
    },
    capabilities: { chat: true, jobs: true },
  },
} as unknown as GatewayIdentity;

type Call = { url: string; method: string; body?: Record<string, unknown> };

function stubFetch(): Call[] {
  const calls: Call[] = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: { object: 'list', data: [] } }),
    } as unknown as Response;
  });
  return calls;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

function feed(routines: RoutineFeed['routines']): RoutineFeed {
  return {
    generatedAt: '2026-11-10T12:00:00.000Z',
    backends: [
      { id: 'hermes-a', label: 'Hermes A', status: 'complete' },
      { id: 'hermes-b', label: 'Hermes B', status: 'complete' },
    ],
    routines,
  };
}

function routine(backendId: string): RoutineFeed['routines'][number] {
  return { id: 'job-1', backendId, name: 'Nightly digest', paused: false };
}

let renderer: ReactTestRenderer | null = null;

async function flush(ms = 1): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function mountRoutines(sheet: RoutineFeed): Promise<void> {
  mockGateway.activityFeed.readRoutines.mockResolvedValue(sheet);
  await act(async () => {
    renderer = create(createElement(RoutinesSection, { reloadSignal: 0 }));
  });
  await flush();
}

async function openRoutine(): Promise<void> {
  const row = renderer?.root.findAllByType('ListRow' as never)[0];
  if (!row) throw new Error('No routine row to open');
  await act(async () => {
    (row.props as { onPress?: () => void }).onPress?.();
  });
  await flush();
}

function button(label: string) {
  return renderer?.root
    .findAllByType('Button' as never)
    .find((node) => (node.props as { label?: string }).label === label);
}

async function press(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`No "${label}" button on the sheet`);
  await act(async () => {
    (target.props as { onPress?: () => void }).onPress?.();
  });
  await flush();
}

async function confirmRemove(): Promise<void> {
  const confirm = renderer?.root
    .findAllByType('ConfirmSheet' as never)
    .find((node) => (node.props as { visible?: boolean }).visible === true);
  if (!confirm) throw new Error('The remove confirmation did not open');
  await act(async () => {
    (confirm.props as { onConfirm?: () => void }).onConfirm?.();
  });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGateway.botJobs.run.mockReset();
  mockGateway.botJobs.pause.mockReset();
  mockGateway.botJobs.remove.mockReset();
  mockGateway.cron.runs.mockReset();
  mockGateway.cron.runs.mockResolvedValue([]);
  mockGateway.activityFeed.readRoutines.mockReset();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a routine on a second backend acts there', () => {
  test('Run now, Pause and Remove name hermes-b, and run history is scoped to it', async () => {
    await mountRoutines(feed([routine('hermes-b')]));
    await openRoutine();

    // The sheet reads the run history of the backend that owns the routine.
    expect(mockGateway.cron.runs).toHaveBeenCalledWith('job-1', 'hermes-b');

    await press('Run now');
    expect(mockGateway.botJobs.run).toHaveBeenCalledWith('job-1', 'hermes-b');

    await press('Pause');
    expect(mockGateway.botJobs.pause).toHaveBeenCalledWith('job-1', true, 'hermes-b');

    await press('Remove');
    await confirmRemove();
    expect(mockGateway.botJobs.remove).toHaveBeenCalledWith('job-1', 'hermes-b');
  });
});

describe('a routine on the default backend keeps today\'s calls', () => {
  test('no action or run-history read names a backend', async () => {
    await mountRoutines(feed([routine('hermes-a')]));
    await openRoutine();

    expect(mockGateway.cron.runs).toHaveBeenCalledWith('job-1');

    await press('Run now');
    expect(mockGateway.botJobs.run).toHaveBeenCalledWith('job-1');

    await press('Pause');
    expect(mockGateway.botJobs.pause).toHaveBeenCalledWith('job-1', true);

    await press('Remove');
    await confirmRemove();
    expect(mockGateway.botJobs.remove).toHaveBeenCalledWith('job-1');
  });
});

describe('the Gate client names the backend in the request', () => {
  test('Run now, Pause and Remove send backendId as a query parameter', async () => {
    const calls = stubFetch();
    const client = new ManifestClient(PROFILE, IDENTITY, {});

    await client.runJob('job-1', 'hermes-b');
    await client.setJobPaused('job-1', true, 'hermes-b');
    await client.removeJob('job-1', 'hermes-b');

    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0].url).toContain('/v1/jobs/job-1/run?backendId=hermes-b');
    expect(calls[1]).toMatchObject({ method: 'POST' });
    expect(calls[1].url).toContain('/v1/jobs/job-1/pause?backendId=hermes-b');
    expect(calls[2]).toMatchObject({ method: 'DELETE' });
    expect(calls[2].url).toContain('/v1/jobs/job-1?backendId=hermes-b');
  });

  test('a call that names no backend is byte-for-byte today\'s request', async () => {
    const calls = stubFetch();
    const client = new ManifestClient(PROFILE, IDENTITY, {});

    await client.runJob('job-1');
    await client.setJobPaused('job-1', true);
    await client.removeJob('job-1');

    expect(calls[0].url).toMatch(/\/v1\/jobs\/job-1\/run$/);
    expect(calls[1].url).toMatch(/\/v1\/jobs\/job-1\/pause$/);
    expect(calls[2].url).toMatch(/\/v1\/jobs\/job-1$/);
    expect(calls.map((call) => call.url).some((url) => url.includes('backendId'))).toBe(false);
    expect(calls[0].body).toEqual({});
  });

  test('run history is scoped through the cron.runs RPC when a backend is named', async () => {
    const calls = stubFetch();
    const client = new ManifestClient(PROFILE, IDENTITY, {});

    await client.cronRuns('job-1', 'hermes-b');
    await client.cronRuns('job-1');

    expect(calls[0].body).toMatchObject({
      method: 'cron.runs',
      params: { jobId: 'job-1', backendId: 'hermes-b' },
    });
    expect(calls[1].body).toMatchObject({
      method: 'cron.runs',
      params: { jobId: 'job-1' },
    });
    expect((calls[1].body as { params: Record<string, unknown> }).params).not.toHaveProperty('backendId');
  });
});

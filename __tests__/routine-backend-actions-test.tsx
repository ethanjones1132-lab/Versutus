import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { RoutinesSection } from '@/components/activity/routines-section';
import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { CronJob } from '@/lib/gateway/cron';
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
  TextField: 'TextField',
  Text: 'Text',
}));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));

const mockGateway = {
  activeGateway: { id: 'gw-a', name: 'Alpha', url: 'http://alpha.test:8642' },
  status: 'connected',
  activityFeed: { readActivity: jest.fn(), readRoutines: jest.fn() },
  botJobs: { run: jest.fn(), pause: jest.fn(), remove: jest.fn(), canUpdate: jest.fn(() => false), update: jest.fn() },
  cron: {
    available: true,
    runs: jest.fn(async () => []),
    list: jest.fn(async (_scope?: { backendId?: string; botId?: string | null }): Promise<CronJob[]> => []),
  },
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

function routine(
  backendId: string,
  scopeBotId: string | null = null,
  botId: string | undefined = scopeBotId ?? undefined,
): RoutineFeed['routines'][number] {
  return { id: 'job-1', backendId, scopeBotId, botId, name: 'Nightly digest', paused: false };
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

async function openRoutine(index = 0): Promise<void> {
  const row = renderer?.root.findAllByType('ListRow' as never)[index];
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

function textContent(): string[] {
  return renderer?.root.findAllByType('Text' as never).flatMap((node) => {
    const value = (node.props as { children?: unknown }).children;
    return typeof value === 'string' ? [value] : [];
  }) ?? [];
}

function fields(): { props: Record<string, unknown> }[] {
  return renderer?.root.findAllByType('TextField' as never) as { props: Record<string, unknown> }[] ?? [];
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
  mockGateway.botJobs.canUpdate.mockReset();
  mockGateway.botJobs.canUpdate.mockReturnValue(false);
  mockGateway.botJobs.update.mockReset();
  mockGateway.cron.runs.mockReset();
  mockGateway.cron.runs.mockResolvedValue([]);
  mockGateway.cron.list.mockReset();
  mockGateway.cron.list.mockResolvedValue([]);
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

    const scope = { backendId: 'hermes-b', botId: null };
    expect(mockGateway.cron.runs).toHaveBeenCalledWith('job-1', scope);

    await press('Run now');
    expect(mockGateway.botJobs.run).toHaveBeenCalledWith('job-1', scope);

    await press('Pause');
    expect(mockGateway.botJobs.pause).toHaveBeenCalledWith('job-1', true, scope);

    await press('Remove');
    await confirmRemove();
    expect(mockGateway.botJobs.remove).toHaveBeenCalledWith('job-1', scope);
  });
});

describe('a Bot-owned routine uses its proven home even when ids collide', () => {
  test('duplicate job ids keep distinct home identity through run history and controls', async () => {
    await mountRoutines(feed([
      routine('hermes-a', 'mira'),
      routine('hermes-a', 'nova'),
    ]));

    expect(renderer?.root.findAllByType('ListRow' as never).slice(0, 2)).toHaveLength(2);

    await openRoutine(1);
    const scope = { backendId: 'hermes-a', botId: 'nova' };
    expect(renderer?.root.findByType(CronJobSheet).props.scope).toEqual(scope);
    expect(renderer?.root.findByType(CronJobSheet).props.job.botId).toBe('nova');
    expect(mockGateway.cron.runs).toHaveBeenCalledWith('job-1', scope);

    await press('Run now');
    expect(mockGateway.botJobs.run).toHaveBeenCalledWith('job-1', scope);

    await press('Pause');
    expect(mockGateway.botJobs.pause).toHaveBeenCalledWith('job-1', true, scope);

    await press('Remove');
    await confirmRemove();
    expect(mockGateway.botJobs.remove).toHaveBeenCalledWith('job-1', scope);
  });

  test('a root row named for Bot root stays distinct from the Bot root home with the same job id', async () => {
    await mountRoutines(feed([
      routine('hermes-a', null, 'root'),
      routine('hermes-a', 'root', 'root'),
    ]));
    expect(renderer?.root.findAllByType('ListRow' as never).slice(0, 2)).toHaveLength(2);

    await openRoutine(1);
    expect(renderer?.root.findByType(CronJobSheet).props.scope).toEqual({ backendId: 'hermes-a', botId: 'root' });
  });

  test('a root-home record keeps its display Bot name but explicitly clears a selected Bot scope', async () => {
    await mountRoutines(feed([routine('hermes-b', null, 'mira')]));
    await openRoutine();

    expect(mockGateway.cron.runs).toHaveBeenCalledWith('job-1', { backendId: 'hermes-b', botId: null });
    expect(textContent()).toContain('Bot: mira');
    expect(button('Edit')).toBeUndefined();
  });

  test('Edit preloads the scoped host record, preserves its Bot prefix, and retains a refused draft', async () => {
    const sheet = feed([routine('hermes-a', 'nova')]);
    const scope = { backendId: 'hermes-a', botId: 'nova' };
    mockGateway.activityFeed.readRoutines.mockResolvedValue(sheet);
    mockGateway.botJobs.canUpdate.mockReturnValue(true);
    mockGateway.cron.list
      .mockResolvedValueOnce([{
      id: 'job-1',
      title: 'Nightly digest',
      name: '[bot:nova] Nightly digest',
      botId: 'nova',
      schedule: '0 9 * * *',
      prompt: 'The existing prompt',
      } as CronJob])
      .mockResolvedValueOnce([{
        id: 'job-1',
        title: 'Morning digest',
        name: '[bot:nova] Morning digest',
        botId: 'nova',
        schedule: '0 9 * * *',
        scheduleDisplay: 'Every day at 9:00 AM EST',
        nextRunAt: '2026-11-15T14:00:00.000Z',
        prompt: 'Revised prompt',
      } as CronJob]);
    mockGateway.botJobs.update
      .mockRejectedValueOnce(new Error('write refused'))
      .mockResolvedValueOnce(undefined);
    await mountRoutines(sheet);
    await openRoutine();

    await press('Edit');
    expect(mockGateway.cron.list).toHaveBeenCalledWith(scope);
    expect(fields().map((field) => field.props.value)).toEqual([
      'Nightly digest', '0 9 * * *', 'The existing prompt',
    ]);
    const titleField = fields()[0];
    const promptField = fields()[2];
    await act(async () => {
      (titleField.props.onChangeText as (value: string) => void)('Morning digest');
      (promptField.props.onChangeText as (value: string) => void)('Revised prompt');
    });

    await press('Save changes');
    expect(mockGateway.botJobs.update).toHaveBeenNthCalledWith(1, 'job-1', {
      name: '[bot:nova] Morning digest',
      schedule: '0 9 * * *',
      prompt: 'Revised prompt',
    }, scope);
    expect(fields().map((field) => field.props.value)).toEqual([
      'Morning digest', '0 9 * * *', 'Revised prompt',
    ]);
    expect(textContent()).toContain('write refused');

    await press('Save changes');
    expect(mockGateway.botJobs.update).toHaveBeenCalledTimes(2);
    expect(mockGateway.cron.list).toHaveBeenNthCalledWith(2, scope);
    expect(textContent()).toContain('Every day at 9:00 AM EST');
    expect(fields()).toHaveLength(0);
  });

  test('Edit does not invent empty fields when the exact job is absent from its home', async () => {
    const sheet = feed([routine('hermes-a', 'nova')]);
    mockGateway.activityFeed.readRoutines.mockResolvedValue(sheet);
    mockGateway.botJobs.canUpdate.mockReturnValue(true);
    mockGateway.cron.list.mockResolvedValue([]);
    await mountRoutines(sheet);
    await openRoutine();

    await press('Edit');
    expect(textContent()).toContain('The gateway did not return this routine, so it cannot be edited safely. Retry the read.');
    expect(button('Save changes')).toBeUndefined();
    expect(fields()).toHaveLength(0);
    expect(mockGateway.botJobs.update).not.toHaveBeenCalled();
  });

  test('a stale post-save list cannot replace submitted fields or raw detail', async () => {
    const sheet = feed([routine('hermes-a', 'nova')]);
    mockGateway.activityFeed.readRoutines.mockResolvedValue(sheet);
    mockGateway.botJobs.canUpdate.mockReturnValue(true);
    const oldJob = {
      id: 'job-1',
      title: 'Nightly digest',
      name: '[bot:nova] Nightly digest',
      botId: 'nova',
      schedule: '0 9 * * *',
      scheduleDisplay: 'Every day at 9:00 AM EST',
      nextRunAt: '2026-11-15T14:00:00.000Z',
      prompt: 'The old prompt',
      promptLength: 15,
      raw: {
        name: '[bot:nova] Nightly digest',
        schedule: '0 9 * * *',
        prompt: 'The old prompt',
      },
    } as CronJob;
    mockGateway.cron.list.mockResolvedValueOnce([oldJob]).mockResolvedValueOnce([oldJob]);
    mockGateway.botJobs.update.mockResolvedValueOnce(undefined);

    await mountRoutines(sheet);
    await openRoutine();
    await press('Edit');

    const [titleField, scheduleField, promptField] = fields();
    await act(async () => {
      (titleField.props.onChangeText as (value: string) => void)('Morning digest');
      (scheduleField.props.onChangeText as (value: string) => void)('0 10 * * *');
      (promptField.props.onChangeText as (value: string) => void)('The revised prompt');
    });
    await press('Save changes');

    expect(mockGateway.botJobs.update).toHaveBeenCalledWith('job-1', {
      name: '[bot:nova] Morning digest',
      schedule: '0 10 * * *',
      prompt: 'The revised prompt',
    }, { backendId: 'hermes-a', botId: 'nova' });
    expect(fields()).toHaveLength(0);
    expect(textContent()).toContain('0 10 * * *');
    expect(textContent()).not.toContain('Every day at 9:00 AM EST');
    expect(textContent()).not.toContain('2026-11-15T14:00:00.000Z');
    expect(textContent()).toContain(
      'Saved. The gateway did not confirm the updated schedule display or next run; showing the saved schedule expression.',
    );

    await press('Show prompt (18 chars)');
    expect(textContent()).toContain('The revised prompt');
    expect(textContent()).not.toContain('The old prompt');

    await press('Show raw record');
    expect(textContent()).toContain('The gateway has not confirmed the updated record yet.');
    expect(textContent()).not.toContain('[bot:nova] Nightly digest');
    expect(textContent()).not.toContain('The old prompt');
  });
});

describe('Activity routine actions keep the row exact even on the default backend', () => {
  test('run history and controls carry an explicit root scope', async () => {
    await mountRoutines(feed([routine('hermes-a')]));
    await openRoutine();

    const scope = { backendId: 'hermes-a', botId: null };
    expect(mockGateway.cron.runs).toHaveBeenCalledWith('job-1', scope);

    await press('Run now');
    expect(mockGateway.botJobs.run).toHaveBeenCalledWith('job-1', scope);

    await press('Pause');
    expect(mockGateway.botJobs.pause).toHaveBeenCalledWith('job-1', true, scope);

    await press('Remove');
    await confirmRemove();
    expect(mockGateway.botJobs.remove).toHaveBeenCalledWith('job-1', scope);
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

  test('explicit Bot-home actions and transcript RPCs override the sticky chat scope', async () => {
    const calls = stubFetch();
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    client.setBotId?.('stale-chat-bot');
    client.setBackendId?.('stale-chat-backend');
    const botScope = { backendId: 'hermes-a', botId: 'mira' };

    await client.runJob('job-1', botScope);
    await client.setJobPaused('job-1', true, botScope);
    await client.removeJob('job-1', botScope);
    await client.runJob('job-root', { backendId: 'hermes-b', botId: null });
    await client.cronRuns('job-1', botScope);
    await client.cronTranscript('cron_job-1_20261114_090000', undefined, botScope);
    await client.cronTranscript('cron_job-root_20261114_090000', undefined, { backendId: 'hermes-b', botId: null });

    expect(calls[0].url).toContain('/v1/jobs/job-1/run?bot=mira&backendId=hermes-a');
    expect(calls[0].body).toEqual({ bot: 'mira' });
    expect(calls[1].url).toContain('/v1/jobs/job-1/pause?bot=mira&backendId=hermes-a');
    expect(calls[1].body).toEqual({ bot: 'mira' });
    expect(calls[2].url).toContain('/v1/jobs/job-1?bot=mira&backendId=hermes-a');
    expect(calls[2].body).toEqual({ bot: 'mira' });
    expect(calls[3].url).toContain('/v1/jobs/job-root/run?backendId=hermes-b');
    expect(calls[3].url).not.toContain('stale-chat');
    expect(calls[3].body).toEqual({});
    expect(calls[4].body).toMatchObject({
      method: 'cron.runs',
      params: { jobId: 'job-1', backendId: 'hermes-a', bot: 'mira' },
    });
    expect(calls[5].body).toMatchObject({
      method: 'cron.transcript',
      params: { runId: 'cron_job-1_20261114_090000', backendId: 'hermes-a', bot: 'mira' },
    });
    expect(calls[6].body).toMatchObject({
      method: 'cron.transcript',
      params: { runId: 'cron_job-root_20261114_090000', backendId: 'hermes-b' },
    });
    expect((calls[6].body as { params: Record<string, unknown> }).params).not.toHaveProperty('bot');
  });

  test('routine edit reads and writes use the exact owner and expose only cron-edit homes', async () => {
    const calls = stubFetch();
    const identity = {
      ...IDENTITY,
      manifest: {
        ...(IDENTITY.manifest ?? {}),
        endpoints: { ...(IDENTITY.manifest?.endpoints ?? {}), jobUpdate: '/v1/jobs/{id}' },
        backends: [
          { id: 'hermes-a', label: 'Hermes A', kind: 'environment', capabilities: ['cron', 'cron-edit'] },
          { id: 'opencode', label: 'OpenCode', kind: 'environment', capabilities: ['cron'] },
        ],
      },
    } as unknown as GatewayIdentity;
    const client = new ManifestClient(PROFILE, identity, {});
    client.setBotId?.('stale-chat-bot');
    client.setBackendId?.('stale-chat-backend');
    const rootScope = { backendId: 'hermes-a', botId: null };

    expect(client.canUpdateJob(rootScope)).toBe(true);
    expect(client.canUpdateJob({ backendId: 'opencode', botId: 'bot-a' })).toBe(false);
    await client.listCronJobs(rootScope);
    await client.updateJob('job-1', {
      name: '[bot:mira] Nightly digest',
      schedule: '0 10 * * *',
      prompt: 'Use the revised prompt',
    }, rootScope);

    expect(calls[0].body).toMatchObject({
      method: 'cron.jobs',
      params: { backendId: 'hermes-a' },
    });
    expect((calls[0].body as { params: Record<string, unknown> }).params).not.toHaveProperty('bot');
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: expect.stringContaining('/v1/jobs/job-1?backendId=hermes-a'),
      body: {
        name: '[bot:mira] Nightly digest',
        schedule: '0 10 * * *',
        prompt: 'Use the revised prompt',
      },
    });
    expect(calls[1].url).not.toContain('stale-chat');
  });
});

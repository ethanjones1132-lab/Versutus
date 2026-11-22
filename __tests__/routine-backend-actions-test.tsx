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
  test('a paused routine does not promise the stale next-run date retained by Hermes', async () => {
    const staleNextRun = '2027-01-01T00:00:00-05:00';
    await mountRoutines(feed([{
      ...routine('hermes-a', 'nova'),
      paused: true,
      schedule: '15 9 * * 1',
      nextRunAt: staleNextRun,
    }]));
    await openRoutine();

    expect(textContent()).not.toContain(staleNextRun);
    expect(textContent()).toContain('Paused');
  });

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

  test('Edit renders Hermes origin metadata as text and retains the full object in raw detail', async () => {
    const sheet = feed([routine('hermes-a', 'nova')]);
    const scope = { backendId: 'hermes-a', botId: 'nova' };
    const origin = {
      platform: 'telegram',
      chat_id: 'chat-42',
      source_ip: '192.0.2.8',
      peer_ip: '192.0.2.9',
      user_agent: 'Hermes/1.0',
    };
    mockGateway.activityFeed.readRoutines.mockResolvedValue(sheet);
    mockGateway.botJobs.canUpdate.mockReturnValue(true);
    mockGateway.cron.list.mockResolvedValueOnce([{
      id: 'job-1',
      title: 'Nightly digest',
      name: '[bot:nova] Nightly digest',
      botId: 'nova',
      schedule: '0 9 * * *',
      prompt: 'The existing prompt',
      origin,
      raw: { origin },
    } as unknown as CronJob]);
    await mountRoutines(sheet);
    await openRoutine();

    expect(button('Show prompt (19 chars)')).toBeDefined();
    await press('Edit');

    expect(textContent()).toContain('telegram · chat-chat-42');
    expect(textContent().join('\n')).not.toContain('[object Object]');
    await press('Show raw record');
    const rawRecord = textContent().join('\n');
    expect(rawRecord).toContain('"source_ip": "192.0.2.8"');
    expect(rawRecord).toContain('"peer_ip": "192.0.2.9"');
    expect(rawRecord).toContain('"user_agent": "Hermes/1.0"');
    expect(mockGateway.cron.list).toHaveBeenCalledWith(scope);
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

  test('a scoped full-detail read preserves the proven Bot owner when the raw name has no prefix', async () => {
    const botId = 'finishline-qa-20261114';
    const sheet = feed([routine('hermes-a', botId)]);
    const detail = {
      id: 'job-1',
      title: 'Nightly digest',
      name: 'Nightly digest',
      schedule: '0 9 * * *',
      prompt: 'The existing prompt',
      botId: null,
    } as CronJob;
    mockGateway.activityFeed.readRoutines.mockResolvedValue(sheet);
    mockGateway.botJobs.canUpdate.mockReturnValue(true);
    mockGateway.cron.list.mockResolvedValueOnce([detail]).mockResolvedValueOnce([detail]);
    mockGateway.botJobs.update.mockResolvedValueOnce(undefined);
    await mountRoutines(sheet);
    await openRoutine();

    expect(textContent()).toContain(`Bot: ${botId}`);
    await press('Edit');

    expect(textContent()).toContain(`Bot: ${botId}`);
    expect(textContent()).not.toContain('the gateway itself');

    await press('Save changes');
    expect(mockGateway.botJobs.update).toHaveBeenCalledWith('job-1', {
      name: 'Nightly digest',
      schedule: '0 9 * * *',
      prompt: 'The existing prompt',
    }, { backendId: 'hermes-a', botId });
    expect(textContent()).toContain(`Bot: ${botId}`);
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
    expect(textContent().join('\n')).toContain('Every day at');
    // The saved expression is spoken in words; the raw cron never reaches the row.
    expect(textContent()).not.toContain('0 10 * * *');
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

describe('routine detail reports latest execution separately from linked transcripts', () => {
  test('an accepted run refreshes its exact detail without waiting for transcript history', async () => {
    const old = { id: 'job-1', title: 'Digest', paused: true,
      latestExecution: { id: 'old-run', status: 'completed' } } as CronJob;
    mockGateway.cron.list.mockResolvedValueOnce([old]).mockResolvedValueOnce([{ ...old, paused: false }]);
    await mountRoutines(feed([{ ...routine('hermes-a', 'nova'), paused: true }]));
    await openRoutine();
    mockGateway.cron.runs.mockImplementationOnce(() => new Promise(() => undefined));
    await press('Run now');
    expect(mockGateway.cron.list).toHaveBeenLastCalledWith({ backendId: 'hermes-a', botId: 'nova' });
    expect(button('Pause')).toBeDefined();
    expect(button('Run now')).toBeDefined();
    expect(textContent()).toContain('Run requested. Refresh details to check whether the gateway has started it.');
    mockGateway.cron.list.mockResolvedValueOnce([{ ...old, paused: false,
      latestExecution: { id: 'new-run', status: 'running' } }]);
    await press('Refresh details');
    expect(textContent()).toContain('running');
    expect(textContent()).not.toContain('Run requested. Refresh details to check whether the gateway has started it.');
  });

  test('resume refreshes the host schedule before rebuilding its phone reminder', async () => {
    const old = { id: 'job-1', title: 'Digest', name: 'Digest', paused: true,
      schedule: '0 0 1 1 *', nextRunAt: '2027-01-01T00:00:00-05:00' } as CronJob;
    const resumed = { ...old, paused: false, schedule: '30 9 * * 1', nextRunAt: '2026-11-16T09:30:00-05:00' };
    mockGateway.cron.list.mockResolvedValueOnce([old]).mockResolvedValueOnce([resumed]);
    await mountRoutines(feed([{ ...routine('hermes-a', 'nova'), paused: true }]));
    await openRoutine();
    await press('Resume');
    expect(jest.requireMock('@/lib/notifications/routine-sync').syncRoutineNotification).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: resumed.schedule, nextRunAt: resumed.nextRunAt, paused: false }),
    );
    // The detail sheet speaks the resumed host schedule in words and the next
    // run on the phone's clock; the raw ISO timestamp is never printed.
    expect(textContent().join('\n')).toContain('Every week on Monday at');
    expect(textContent()).not.toContain(resumed.nextRunAt);
    expect(button('Pause')).toBeDefined();
  });

  test('opening a scoped routine reads its full detail and shows a completed execution', async () => {
    const botId = 'finishline-qa-20261114';
    const scope = { backendId: 'hermes-a', botId };
    mockGateway.cron.list.mockResolvedValueOnce([{
      id: 'job-1',
      title: 'Finish-line live proof',
      name: 'Finish-line live proof',
      schedule: '0 0 1 1 *',
      prompt: 'Reply exactly FINISHLINE_ROUTINE_OK.',
      botId: null,
      latestExecution: {
        id: 'execution-qa',
        status: 'completed',
        started_at: '2026-11-14T18:26:21.548Z',
        finished_at: '2026-11-14T18:26:34.840Z',
        error: null,
      },
    } as CronJob]);
    await mountRoutines(feed([routine('hermes-a', botId)]));
    await openRoutine();

    expect(mockGateway.cron.list).toHaveBeenCalledWith(scope);
    expect(textContent()).toContain('LATEST RUN');
    expect(textContent()).toContain('completed');
    expect(textContent()).toContain('2026-11-14T18:26:21.548Z');
    expect(textContent()).toContain('2026-11-14T18:26:34.840Z');
    expect(textContent()).toContain('CONVERSATION TRANSCRIPTS (0)');
    expect(textContent()).toContain('Earlier transcripts may be unavailable on this gateway.');
    expect(textContent()).toContain('No linked transcripts are available.');
  });

  test('a failed latest execution shows its recorded error without calling it completed', async () => {
    mockGateway.cron.list.mockResolvedValueOnce([{
      id: 'job-1',
      title: 'Nightly digest',
      name: 'Nightly digest',
      schedule: '0 9 * * *',
      prompt: 'The prompt',
      latestExecution: {
        status: 'failed',
        started_at: '2026-11-14T18:20:00.000Z',
        finished_at: '2026-11-14T18:20:14.000Z',
        error: 'The provider refused the model.',
      },
    } as CronJob]);
    await mountRoutines(feed([routine('hermes-a')]));
    await openRoutine();

    expect(textContent()).toContain('failed');
    expect(textContent()).toContain('The provider refused the model.');
    expect(textContent()).not.toContain('completed');
  });

  test('unknown latest-execution field shapes render as unknown text safely', async () => {
    mockGateway.cron.list.mockResolvedValueOnce([{
      id: 'job-1',
      title: 'Nightly digest',
      name: 'Nightly digest',
      latestExecution: {
        status: { internal: 'future-status' },
        started_at: ['not a timestamp'],
        finished_at: { unknown: true },
        error: { code: 'future-error' },
      },
    } as unknown as CronJob]);
    await mountRoutines(feed([routine('hermes-a')]));
    await openRoutine();

    expect(textContent()).toContain('LATEST RUN');
    expect(textContent().join('\n')).not.toContain('[object Object]');
    expect(textContent().join('\n')).not.toContain('future-status');
    expect(textContent().join('\n')).not.toContain('future-error');
  });

  test('a failed full-detail read retries, then edit refusal retains the recovered draft', async () => {
    const detail = {
      id: 'job-1',
      title: 'Nightly digest',
      name: '[bot:nova] Nightly digest',
      botId: 'nova',
      schedule: '0 9 * * *',
      prompt: 'The existing prompt',
      latestExecution: { status: 'completed' },
    } as CronJob;
    mockGateway.botJobs.canUpdate.mockReturnValue(true);
    mockGateway.cron.list.mockRejectedValueOnce(new Error('detail read refused')).mockResolvedValueOnce([detail]);
    mockGateway.botJobs.update.mockRejectedValueOnce(new Error('write refused'));
    await mountRoutines(feed([routine('hermes-a', 'nova')]));
    await openRoutine();

    const readError = renderer?.root.findAllByType('ErrorCard' as never)
      .find((node) => (node.props as { affected?: string }).affected === 'The routine details');
    expect(readError?.props.cause).toBe('detail read refused');
    const retryRead = readError?.props.onRetry as (() => void) | undefined;
    expect(retryRead).toBeDefined();
    await act(async () => { retryRead?.(); });
    await flush();
    expect(mockGateway.cron.list).toHaveBeenCalledTimes(2);

    await press('Edit');
    const [titleField, , promptField] = fields();
    await act(async () => {
      (titleField.props.onChangeText as (value: string) => void)('Draft title');
      (promptField.props.onChangeText as (value: string) => void)('Draft prompt after retry');
    });
    await press('Save changes');

    expect(fields().map((field) => field.props.value)).toEqual([
      'Draft title', '0 9 * * *', 'Draft prompt after retry',
    ]);
    expect(textContent()).toContain('write refused');
  });

  test('a detail response from the previous Bot home cannot replace a newer selection', async () => {
    let resolveOld: (jobs: CronJob[]) => void = () => undefined;
    const oldRead = new Promise<CronJob[]>((resolve) => { resolveOld = resolve; });
    const oldDetail = {
      id: 'same-job', title: 'Old home detail', name: 'Old home detail', schedule: '0 8 * * *', prompt: 'old',
    } as CronJob;
    const newDetail = {
      id: 'same-job', title: 'New home detail', name: 'New home detail', schedule: '0 9 * * *', prompt: 'new',
    } as CronJob;
    mockGateway.cron.list.mockImplementationOnce(() => oldRead).mockResolvedValueOnce([newDetail]);

    await act(async () => {
      renderer = create(createElement(CronJobSheet, {
        job: { id: 'same-job', title: 'Routine' },
        scope: { backendId: 'hermes-a', botId: 'nova' },
        onClose: () => undefined,
        onOpenRun: () => undefined,
      }));
    });
    await flush();
    await act(async () => {
      renderer?.update(createElement(CronJobSheet, {
        job: { id: 'same-job', title: 'Routine' },
        scope: { backendId: 'hermes-b', botId: 'mira' },
        onClose: () => undefined,
        onOpenRun: () => undefined,
      }));
    });
    await flush();

    expect(mockGateway.cron.list).toHaveBeenNthCalledWith(1, { backendId: 'hermes-a', botId: 'nova' });
    expect(mockGateway.cron.list).toHaveBeenNthCalledWith(2, { backendId: 'hermes-b', botId: 'mira' });
    expect(textContent().join('\n')).toMatch(/Every day at 0?9:00/);

    await act(async () => { resolveOld([oldDetail]); });
    await flush();
    expect(textContent().join('\n')).toMatch(/Every day at 0?9:00/);
    expect(textContent().join('\n')).not.toMatch(/Every day at 0?8:00/);
  });

  test('the legacy backendId-only sheet scopes its full-detail read to that backend', async () => {
    mockGateway.cron.list.mockResolvedValueOnce([{
      id: 'legacy-job',
      title: 'Legacy routine detail',
      name: 'Legacy routine detail',
      schedule: '0 9 * * *',
      prompt: 'the detail',
    } as CronJob]);
    await act(async () => {
      renderer = create(createElement(CronJobSheet, {
        job: { id: 'legacy-job', title: 'Legacy routine' },
        backendId: 'hermes-b',
        onClose: () => undefined,
        onOpenRun: () => undefined,
      }));
    });
    await flush();

    expect(mockGateway.cron.list).toHaveBeenCalledWith({ backendId: 'hermes-b' });
    expect(textContent().join('\n')).toMatch(/Every day at 0?9:00/);
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

  // VS-121: Activity's New routine creates on the backend and Bot the person
  // picked, which may not be the chat's. No scope keeps today's request.
  test('New routine creates on the named backend and Bot, or the root when botId is null', async () => {
    const calls = stubFetch();
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    client.setBotId?.('stale-chat-bot');
    const job = { name: 'inbox', prompt: 'Summarize mail', schedule: '0 9 * * 1-5' };

    await client.createJob(job, { backendId: 'claude-code', botId: null });
    await client.createJob(job, { backendId: 'hermes-a', botId: 'mira' });
    await client.createJob(job);

    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0].url).toContain('/v1/jobs?backendId=claude-code');
    expect(calls[0].url).not.toContain('bot=');
    expect(calls[0].body).toEqual({ ...job, backendId: 'claude-code' });
    expect(calls[1].url).toContain('bot=mira');
    expect(calls[1].url).toContain('backendId=hermes-a');
    expect(calls[1].body).toEqual({ ...job, bot: 'mira', backendId: 'hermes-a' });
    expect(calls[2].url).not.toContain('backendId');
    expect(calls[2].body).toEqual({ ...job, bot: 'stale-chat-bot' });
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

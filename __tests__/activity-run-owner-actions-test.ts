// Stopping or replaying an Activity run must use the run's owning Gateway
// client. A run started on gateway A cannot be stopped or replayed from
// gateway B — the action must refuse honestly when the operator has switched
// gateways. Legacy runs without a gatewayId fall back to the active gateway
// (preserving existing behavior).

const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import {
  loadActivityRuns,
  normalizeRestoredRuns,
  saveActivityRuns,
} from '@/lib/gateway/session-persistence';
import type { ActivityRun } from '@/lib/gateway/runs';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

const ACTIVITY_RUNS_KEY = 'versutus:activity-runs';

function row(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-1',
    prompt: 'do thing',
    status: 'running',
    startedAt: 1,
    events: [],
    ...overrides,
  };
}

function stored(raw: unknown): void {
  mockStore.set(ACTIVITY_RUNS_KEY, JSON.stringify(raw));
}

describe('a run remembers the gateway it was started on', () => {
  test('a gateway-stamped row keeps its gatewayId through the restore rewrite', () => {
    const next = normalizeRestoredRuns([
      row({ id: 'a', status: 'running', gatewayId: 'gateway-1' }),
      row({ id: 'b', status: 'waiting-approval', gatewayId: 'gateway-2' }),
    ]);
    // The rewrite changes the fate, never the gateway it ran on.
    expect(next[0].status).toBe('unresolved');
    expect(next[0].gatewayId).toBe('gateway-1');
    expect(next[1].status).toBe('unresolved');
    expect(next[1].gatewayId).toBe('gateway-2');
  });

  test('a finished gateway-stamped row restores byte-identical', () => {
    const finished: ActivityRun[] = [
      row({ id: 'c', status: 'complete', finishedAt: 4, summary: 'ok', gatewayId: 'gateway-1' }),
      row({ id: 'd', status: 'failed', finishedAt: 5, summary: 'boom', gatewayId: 'gateway-2' }),
    ];
    expect(normalizeRestoredRuns(finished)).toEqual(finished);
  });

  test('a legacy row with no gatewayId restores byte-identical — never dropped, never guessed', () => {
    const legacy: ActivityRun[] = [
      row({ id: 'e', status: 'complete', finishedAt: 6, summary: 'ok' }),
    ];
    const next = normalizeRestoredRuns(legacy);
    expect(next).toEqual(legacy);
    expect(next).toHaveLength(1);
    expect(next[0]).not.toHaveProperty('gatewayId');
  });

  test('a legacy in-flight row is re-marked interrupted with no gatewayId invented', () => {
    const next = normalizeRestoredRuns([row({ id: 'f', status: 'running' })]);
    expect(next[0].status).toBe('unresolved');
    expect(next[0]).not.toHaveProperty('gatewayId');
  });

  test('the stamp survives the persist/load round trip', async () => {
    mockStore.clear();
    const stamped = row({ id: 'g', status: 'complete', finishedAt: 7, gatewayId: 'gateway-1' });

    await saveActivityRuns([stamped]);

    expect(await loadActivityRuns()).toEqual([stamped]);
  });

  test('a stored legacy row loads untouched — the loader adds no gatewayId field', async () => {
    mockStore.clear();
    const legacy = [
      { id: 'h', prompt: 'old work', status: 'complete', startedAt: 1, finishedAt: 2, summary: 'ok', events: [] },
    ];
    stored(legacy);

    const loaded = await loadActivityRuns();

    expect(loaded).toEqual(legacy);
    expect(loaded[0]).not.toHaveProperty('gatewayId');
  });

  test('the run creation site stamps the active gateway id', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const creation = between(src, 'patchActivityRuns((prev) => [', ']);');
    expect(creation).toContain("status: 'running'");
    expect(creation).toContain('gatewayId');
  });

  test('no later run mutation invents a gatewayId for a row that already has one', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    // The row-keyed patch helper only merges the caller's fields.
    const helper = between(src, 'const patchRun =', 'patchActivityRuns((prev) => [');
    expect(helper).not.toContain('gatewayId');
    // The id re-key and the event append leave the row's gateway alone.
    const rekey = between(src, 'const trackedId = { current: localId };', 'const outcome = await executeRun');
    expect(rekey).not.toContain('gatewayId');
  });

  test('the field is optional on the activity-run shape, so an old row can lack it', () => {
    const src = readSource('src', 'lib', 'gateway', 'runs.ts');
    const shape = between(src, 'export type ActivityRun = {', '};');
    expect(shape).toContain('gatewayId?: string;');
  });
});

describe('stopActivityRun refuses stale-owner actions', () => {
  test('stopActivityRun checks the run gatewayId against the active gateway', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const stopFn = between(src, 'const stopActivityRun = useCallback(', '},');
    // Must read the run from the ref (via runs.find or activityRunsRef.current.find)
    expect(stopFn).toContain('.find((r) => r.id === runId)');
    // Must read the active gateway id from the ref
    expect(stopFn).toContain('activeGatewayRef.current');
    // Must refuse when gatewayId exists and doesn't match
    expect(stopFn).toContain('run?.gatewayId && run.gatewayId !== activeGatewayId');
    // Must patch the run with a failure status and honest message
    expect(stopFn).toContain('status: \'failed\'');
    expect(stopFn).toContain('belongs to another gateway');
  });

  test('stopActivityRun allows action when gatewayId matches active gateway', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const stopFn = between(src, 'const stopActivityRun = useCallback(', '},');
    // Must still call serverSideCancelForCommand when allowed
    expect(stopFn).toContain('serverSideCancelForCommand');
    // Must still patch to cancelled when allowed
    expect(stopFn).toContain('status: \'cancelled\'');
  });

  test('stopActivityRun allows action for legacy runs without gatewayId (fallback behavior)', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const stopFn = between(src, 'const stopActivityRun = useCallback(', '},');
    // The condition `run?.gatewayId && run.gatewayId !== activeGatewayId` is falsy when gatewayId is undefined
    // so legacy runs without gatewayId fall through to the normal stop path
    expect(stopFn).toContain('run?.gatewayId && run.gatewayId !== activeGatewayId');
  });
});

describe('loadRunEvents refuses stale-owner replays', () => {
  test('loadRunEvents checks the run gatewayId against the active gateway', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const loadFn = between(src, 'const loadRunEvents = useCallback(', '},');
    // Must read the run from the ref
    expect(loadFn).toContain('activityRunsRef.current.find');
    // Must read the active gateway id from the ref
    expect(loadFn).toContain('activeGatewayRef.current');
    // Must refuse when gatewayId exists and doesn't match
    expect(loadFn).toContain('run?.gatewayId && run.gatewayId !== activeGatewayId');
    // Must throw an honest error
    expect(loadFn).toContain('belongs to another gateway');
    expect(loadFn).toContain('throw new Error');
  });

  test('loadRunEvents allows replay when gatewayId matches active gateway', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const loadFn = between(src, 'const loadRunEvents = useCallback(', '},');
    // Must still call client.streamRunEvents when allowed
    expect(loadFn).toContain('client.streamRunEvents');
  });

  test('loadRunEvents allows replay for legacy runs without gatewayId (fallback behavior)', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const loadFn = between(src, 'const loadRunEvents = useCallback(', '},');
    // The condition `run?.gatewayId && run.gatewayId !== activeGatewayId` is falsy when gatewayId is undefined
    // so legacy runs without gatewayId fall through to the normal replay path
    expect(loadFn).toContain('run?.gatewayId && run.gatewayId !== activeGatewayId');
  });
});
// Activity runs must stay attached to the Gateway that created them.
// Home, Activity, and Fleet must only show runs for the active gateway.
// Legacy runs without gatewayId fall back to the active gateway (preserving existing behavior).

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

describe('activity runs are scoped to their owning gateway', () => {
  test('normalizeRestoredRuns preserves gatewayId on interrupted runs', () => {
    const next = normalizeRestoredRuns([
      row({ id: 'a', status: 'running', gatewayId: 'gateway-1' }),
      row({ id: 'b', status: 'waiting-approval', gatewayId: 'gateway-2' }),
    ]);
    expect(next[0].status).toBe('unresolved');
    expect(next[0].gatewayId).toBe('gateway-1');
    expect(next[1].status).toBe('unresolved');
    expect(next[1].gatewayId).toBe('gateway-2');
  });

  test('normalizeRestoredRuns preserves gatewayId on finished runs', () => {
    const finished: ActivityRun[] = [
      row({ id: 'c', status: 'complete', finishedAt: 4, summary: 'ok', gatewayId: 'gateway-1' }),
      row({ id: 'd', status: 'failed', finishedAt: 5, summary: 'boom', gatewayId: 'gateway-2' }),
    ];
    expect(normalizeRestoredRuns(finished)).toEqual(finished);
  });

  test('legacy runs without gatewayId restore byte-identical', () => {
    const legacy: ActivityRun[] = [
      row({ id: 'e', status: 'complete', finishedAt: 6, summary: 'ok' }),
    ];
    const next = normalizeRestoredRuns(legacy);
    expect(next).toEqual(legacy);
    expect(next[0]).not.toHaveProperty('gatewayId');
  });

  test('legacy in-flight runs re-marked interrupted with no gatewayId invented', () => {
    const next = normalizeRestoredRuns([row({ id: 'f', status: 'running' })]);
    expect(next[0].status).toBe('unresolved');
    expect(next[0]).not.toHaveProperty('gatewayId');
  });

  test('gatewayId survives persist/load round trip', async () => {
    mockStore.clear();
    const stamped = row({ id: 'g', status: 'complete', finishedAt: 7, gatewayId: 'gateway-1' });

    await saveActivityRuns([stamped]);

    expect(await loadActivityRuns()).toEqual([stamped]);
  });

  test('stored legacy row loads untouched — loader adds no gatewayId', async () => {
    mockStore.clear();
    const legacy = [
      { id: 'h', prompt: 'old work', status: 'complete', startedAt: 1, finishedAt: 2, summary: 'ok', events: [] },
    ];
    stored(legacy);

    const loaded = await loadActivityRuns();

    expect(loaded).toEqual(legacy);
    expect(loaded[0]).not.toHaveProperty('gatewayId');
  });
});

describe('gateway-provider filters activityRuns by active gateway', () => {
  test('activityRunsForActiveGateway is derived from activityRuns and activeGateway', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const derivation = between(src, 'const activityRunsForActiveGateway = useMemo(', '},');
    // The scoping rule itself lives in runsForGateway (tested below); legacy runs
    // with no gatewayId stay visible instead of vanishing from Home and Activity.
    expect(derivation).toContain('runsForGateway(activityRuns, activeGateway?.id)');
  });

  test('activityRunsForActiveGateway is exposed in the context value', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const value = between(src, 'const value = useMemo<GatewayContextValue>(', '});');
    expect(value).toContain('activityRunsForActiveGateway');
  });

  test('activityRunsForActiveGateway type is declared in GatewayContextValue', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    expect(src).toContain('activityRunsForActiveGateway: ActivityRun[];');
  });
});

describe('HomeBriefingCard uses activityRunsForActiveGateway', () => {
  test('HomeBriefingCard destructures activityRunsForActiveGateway from useGateway', () => {
    const src = readSource('src', 'components', 'home-briefing-card.tsx');
    const destructure = between(src, 'const {', '} = useGateway();');
    expect(destructure).toContain('activityRunsForActiveGateway');
  });

  test('HomeBriefingCard passes activityRunsForActiveGateway to buildHomeBriefing', () => {
    const src = readSource('src', 'components', 'home-briefing-card.tsx');
    const briefingCall = between(src, 'buildHomeBriefing(', ')');
    expect(briefingCall).toContain('activityRunsForActiveGateway');
  });
});

describe('RunsScreen uses activityRunsForActiveGateway', () => {
  test('RunsScreen destructures activityRunsForActiveGateway from useGateway', () => {
    const src = readSource('src', 'app', 'runs.tsx');
    const destructure = between(src, 'const {', '} = useGateway();');
    expect(destructure).toContain('activityRunsForActiveGateway');
  });

  test('visibleRuns filters activityRunsForActiveGateway by Bot', () => {
    const src = readSource('src', 'app', 'runs.tsx');
    const visibleRuns = between(src, 'const visibleRuns = useMemo(', '},');
    expect(visibleRuns).toContain('activityRunsForActiveGateway');
    expect(visibleRuns).toContain('filterRunsByBot');
  });

  test('ScorecardsSection receives activityRunsForActiveGateway', () => {
    const src = readSource('src', 'app', 'runs.tsx');
    const scorecards = between(src, '<ScorecardsSection ', ' />');
    expect(scorecards).toContain('runs={activityRunsForActiveGateway}');
  });

  test('EmptyState checks activityRunsForActiveGateway.length', () => {
    const src = readSource('src', 'app', 'runs.tsx');
    expect(src).toContain('activityRunsForActiveGateway.length === 0');
  });
});

describe('FleetScreen uses activityRunsForActiveGateway', () => {
  test('FleetScreen destructures activityRunsForActiveGateway from useGateway', () => {
    const src = readSource('src', 'app', 'fleet.tsx');
    const destructure = between(src, 'const {', '} = useGateway();');
    expect(destructure).toContain('activityRunsForActiveGateway');
  });

  test('fleetConstellationInput receives activityRunsForActiveGateway', () => {
    const src = readSource('src', 'app', 'fleet.tsx');
    const input = between(src, 'fleetConstellationInput({', '}),');
    expect(input).toContain('activityRuns: activityRunsForActiveGateway');
  });

  test('model memo dependency includes activityRunsForActiveGateway', () => {
    const src = readSource('src', 'app', 'fleet.tsx');
    const modelDeps = between(src, 'const model = useMemo(', '});');
    expect(modelDeps).toContain('activityRunsForActiveGateway');
  });
});

describe('stopActivityRun and loadRunEvents respect gateway ownership', () => {
  test('stopActivityRun refuses when run gatewayId differs from active gateway', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const stopFn = between(src, 'const stopActivityRun = useCallback(', '},');
    expect(stopFn).toContain('run?.gatewayId && run.gatewayId !== activeGatewayId');
    expect(stopFn).toContain('belongs to another gateway');
  });

  test('loadRunEvents refuses when run gatewayId differs from active gateway', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const loadFn = between(src, 'const loadRunEvents = useCallback(', '},');
    expect(loadFn).toContain('run?.gatewayId && run.gatewayId !== activeGatewayId');
    expect(loadFn).toContain('belongs to another gateway');
  });

  test('legacy runs without gatewayId fall through to normal stop/replay', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const stopFn = between(src, 'const stopActivityRun = useCallback(', '},');
    const loadFn = between(src, 'const loadRunEvents = useCallback(', '},');
    // The condition is falsy when gatewayId is undefined, so legacy runs are allowed
    expect(stopFn).toContain('run?.gatewayId && run.gatewayId !== activeGatewayId');
    expect(loadFn).toContain('run?.gatewayId && run.gatewayId !== activeGatewayId');
  });
});
describe('runsForGateway', () => {
  const { runsForGateway } = jest.requireActual('@/lib/gateway/runs') as typeof import('@/lib/gateway/runs');
  const run = (id: string, gatewayId?: string): ActivityRun => ({
    id,
    prompt: id,
    status: 'complete',
    startedAt: 1,
    events: [],
    ...(gatewayId ? { gatewayId } : {}),
  });
  const ids = (runs: ActivityRun[]) => runs.map((r) => r.id);

  test("keeps the active gateway's runs and drops another gateway's", () => {
    expect(ids(runsForGateway([run('a', 'gw-1'), run('b', 'gw-2')], 'gw-1'))).toEqual(['a']);
  });

  test('a run saved before gatewayId existed stays visible instead of vanishing', () => {
    expect(ids(runsForGateway([run('legacy'), run('a', 'gw-1'), run('b', 'gw-2')], 'gw-1'))).toEqual(['legacy', 'a']);
  });

  test('with no active gateway nothing is shown', () => {
    expect(runsForGateway([run('legacy'), run('a', 'gw-1')], undefined)).toEqual([]);
  });
});

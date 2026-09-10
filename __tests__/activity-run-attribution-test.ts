// A run's Bot attribution. Scorecards fold runs per Bot (FUTURE-ITEMS.md D3
// step zero), so a row has to remember which Bot it was started for — and a
// row persisted before the field existed has to restore as-is, unattributed
// rather than guessed. The stamp is written at the one creation site
// (src/context/gateway-provider.tsx) from the app's selected Bot scope; no
// run mutation invents one afterwards.

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

/** The device storage key the run list is persisted under. */
const ACTIVITY_RUNS_KEY = 'versutus:activity-runs';

/** A row is a run that never named a Bot until the stamp landed at creation. */
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

/** Put a stored payload (or a legacy one) where the loader will read it. */
function stored(raw: unknown): void {
  mockStore.set(ACTIVITY_RUNS_KEY, JSON.stringify(raw));
}

describe('a run remembers the Bot it was started for', () => {
  test('a Bot-stamped row keeps its Bot through the restore rewrite', () => {
    const next = normalizeRestoredRuns([
      row({ id: 'a', status: 'running', botId: 'scout' }),
      row({ id: 'b', status: 'waiting-approval', botId: 'scribe' }),
    ]);
    // The rewrite changes the fate, never the Bot it ran on.
    expect(next[0].status).toBe('unresolved');
    expect(next[0].botId).toBe('scout');
    expect(next[1].status).toBe('unresolved');
    expect(next[1].botId).toBe('scribe');
  });

  test('a finished Bot-stamped row restores byte-identical', () => {
    const finished: ActivityRun[] = [
      row({ id: 'c', status: 'complete', finishedAt: 4, summary: 'ok', botId: 'scout' }),
      row({ id: 'd', status: 'failed', finishedAt: 5, summary: 'boom', botId: 'scout' }),
    ];
    expect(normalizeRestoredRuns(finished)).toEqual(finished);
  });

  test('a legacy row with no Bot restores byte-identical — never dropped, never guessed', () => {
    const legacy: ActivityRun[] = [
      row({ id: 'e', status: 'complete', finishedAt: 6, summary: 'ok' }),
    ];
    const next = normalizeRestoredRuns(legacy);
    expect(next).toEqual(legacy);
    expect(next).toHaveLength(1);
    expect(next[0]).not.toHaveProperty('botId');
  });

  test('a legacy in-flight row is re-marked interrupted with no Bot invented', () => {
    const next = normalizeRestoredRuns([row({ id: 'f', status: 'running' })]);
    expect(next[0].status).toBe('unresolved');
    expect(next[0]).not.toHaveProperty('botId');
  });

  test('the stamp survives the persist/load round trip', async () => {
    mockStore.clear();
    const stamped = row({ id: 'g', status: 'complete', finishedAt: 7, botId: 'scout' });

    await saveActivityRuns([stamped]);

    expect(await loadActivityRuns()).toEqual([stamped]);
  });

  test('a stored legacy row loads untouched — the loader adds no Bot field', async () => {
    mockStore.clear();
    const legacy = [
      { id: 'h', prompt: 'old work', status: 'complete', startedAt: 1, finishedAt: 2, summary: 'ok', events: [] },
    ];
    stored(legacy);

    const loaded = await loadActivityRuns();

    expect(loaded).toEqual(legacy);
    expect(loaded[0]).not.toHaveProperty('botId');
  });

  test('the run creation site stamps the app’s selected Bot scope', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const creation = between(src, 'patchActivityRuns((prev) => [', ']);');
    expect(creation).toContain("status: 'running'");
    expect(creation).toContain('botId: selectedBotIdRef.current');
  });

  test('no later run mutation invents a Bot for a row that already has one', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    // The row-keyed patch helper only merges the caller's fields.
    const helper = between(src, 'const patchRun =', 'patchActivityRuns((prev) => [');
    expect(helper).not.toContain('botId');
    // The id re-key and the event append leave the row's Bot alone.
    const rekey = between(src, 'const trackedId = { current: localId };', 'const outcome = await executeRun');
    expect(rekey).not.toContain('botId');
  });

  test('the field is optional on the activity-run shape, so an old row can lack it', () => {
    const src = readSource('src', 'lib', 'gateway', 'runs.ts');
    const shape = between(src, 'export type ActivityRun = {', '};');
    expect(shape).toContain('botId?: string;');
  });
});

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

import { loadActivityRuns, saveActivityRuns } from '@/lib/gateway/session-persistence';
import { keyValueStorage } from '@/lib/storage/key-value';
import type { ActivityRun } from '@/lib/gateway/runs';

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;
const mockRemove = keyValueStorage.removeItem as jest.Mock;

const ACTIVITY_RUNS_KEY = 'versutus:activity-runs';

function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-1',
    prompt: 'do thing',
    status: 'running',
    startedAt: 1,
    events: [],
    ...overrides,
  };
}

/**
 * Activity runs persist as one whole-list write to a single key, and a run's
 * start/event/finish updates land in rapid succession. Without ordering a slow
 * older save can land after a newer one and leave stale runs on disk. These
 * tests pin the serialized queue: every save writes in enqueue order, so the
 * newest enqueued list is always the last one written.
 */
describe('activity run persistence order', () => {
  const backing = new Map<string, string>();

  const flushMicrotasks = async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  };

  const stored = (): ActivityRun[] => {
    const raw = backing.get(ACTIVITY_RUNS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ActivityRun[];
  };

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset();
    mockSet.mockReset();
    mockRemove.mockReset();
    mockGet.mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockSet.mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
    mockRemove.mockImplementation(async (key: string) => {
      backing.delete(key);
    });
  });

  test('an in-flight older save cannot overwrite a newer run state', async () => {
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const written: string[] = [];
    let setCount = 0;
    mockSet.mockImplementation(async (key: string, value: string) => {
      setCount += 1;
      if (setCount === 1) await firstHold;
      written.push(value);
      backing.set(key, value);
    });

    const newerState = run({ id: 'run-1', status: 'complete', finishedAt: 9, summary: 'done' });
    const starting = saveActivityRuns([run({ id: 'run-1', status: 'running' })]);
    await flushMicrotasks();
    // The first save is writing but still held.
    expect(mockSet).toHaveBeenCalledTimes(1);

    const finishing = saveActivityRuns([newerState]);
    await flushMicrotasks();
    // The newer save is queued behind the held write: it must not have started
    // yet, or its write would have landed and the release would clobber it.
    expect(mockSet).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([starting, finishing]);

    expect(mockSet).toHaveBeenCalledTimes(2);
    expect(JSON.parse(written[1])).toEqual([newerState]);
    expect(stored()).toEqual([newerState]);
  });

  test('rapid start/event/finish saves land newest-last', async () => {
    await Promise.all([
      saveActivityRuns([run({ id: 'run-1', status: 'running', startedAt: 1 })]),
      saveActivityRuns([
        run({
          id: 'run-1',
          status: 'running',
          startedAt: 1,
          events: [{ type: 'event', preview: 'working' }],
        }),
      ]),
      saveActivityRuns([
        run({
          id: 'run-1',
          status: 'complete',
          startedAt: 1,
          finishedAt: 9,
          events: [],
          summary: 'done',
        }),
      ]),
    ]);

    expect(mockSet).toHaveBeenCalledTimes(3);
    expect(stored()).toEqual([
      run({ id: 'run-1', status: 'complete', startedAt: 1, finishedAt: 9, events: [], summary: 'done' }),
    ]);
  });

  test('a failed save rejects its caller without stranding later saves', async () => {
    mockSet.mockImplementationOnce(async () => {
      throw new Error('storage unavailable');
    });

    await expect(saveActivityRuns([run({ id: 'run-ghost', status: 'running' })])).rejects.toThrow(
      'storage unavailable',
    );

    await saveActivityRuns([run({ id: 'run-kept', status: 'complete' })]);

    expect(stored()).toEqual([run({ id: 'run-kept', status: 'complete' })]);
  });

  test('the newest capped list survives a restart', async () => {
    const many: ActivityRun[] = [];
    for (let i = 0; i < 45; i += 1) {
      many.push(run({ id: `run-${i}`, prompt: `task ${i}`, status: 'complete' }));
    }

    await saveActivityRuns(many);

    const restored = await loadActivityRuns();
    expect(restored).toHaveLength(40);
    expect(restored[0].id).toBe('run-0');
    expect(restored[39].id).toBe('run-39');
  });

  test('an empty list still removes storage', async () => {
    await saveActivityRuns([run({ id: 'run-1', status: 'complete' })]);
    expect(backing.has(ACTIVITY_RUNS_KEY)).toBe(true);

    await saveActivityRuns([]);

    expect(mockRemove).toHaveBeenCalledWith(ACTIVITY_RUNS_KEY);
    expect(backing.has(ACTIVITY_RUNS_KEY)).toBe(false);
    expect(await loadActivityRuns()).toEqual([]);
  });
});
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

/**
 * A run streams tool events for minutes, and every one of them folds the whole
 * 40-row activity list and writes it back as one JSON blob. AsyncStorage is a
 * SQLite transaction per write, so an uncollapsed burst queues one transaction
 * per event — none of which can be reordered away, because ordering is all the
 * queue promised. `transcript.ts` documents the twin of this hazard for
 * transcripts and debounces it; this is the coalescing test for the runs list.
 */
describe('a run\'s event stream does not write the whole list once per event', () => {
  const backing = new Map<string, string>();

  const flushMicrotasks = async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  };

  const stored = (): ActivityRun[] => {
    const raw = backing.get(ACTIVITY_RUNS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ActivityRun[];
  };

  /** The fold `patchActivityRuns` runs for each event of a running run. */
  function fold(events: number): ActivityRun[] {
    return [
      {
        id: 'run-1',
        prompt: 'sweep the garage',
        status: 'running',
        startedAt: 1,
        events: Array.from({ length: events }, (_unused, index) => ({
          type: 'tool',
          preview: `step ${index}`,
        })),
      },
    ];
  }

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset();
    mockSet.mockReset();
    mockRemove.mockReset();
    mockGet.mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockRemove.mockImplementation(async (key: string) => {
      backing.delete(key);
    });
  });

  test('500 events on one run cost a handful of writes, and the newest list is what lands', async () => {
    // A store slower than the event rate — the case the queue cannot help with
    // unless superseded lists are dropped rather than merely ordered.
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    mockSet.mockImplementation(async (key: string, value: string) => {
      if (held === 0) {
        held += 1;
        await hold;
      }
      backing.set(key, value);
    });

    const writes = Array.from({ length: 500 }, (_unused, index) => saveActivityRuns(fold(index + 1)));
    await flushMicrotasks();
    release();
    await Promise.all(writes);

    expect(mockSet.mock.calls.length).toBeLessThanOrEqual(3);
    // The last list is never the one that is dropped.
    expect(stored()[0].events).toHaveLength(500);
  });

  test('a run that settles still writes its finished row even mid-burst', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    mockSet.mockImplementation(async (key: string, value: string) => {
      if (held === 0) {
        held += 1;
        await hold;
      }
      backing.set(key, value);
    });

    const burst = [saveActivityRuns(fold(1)), saveActivityRuns(fold(2))];
    const finished = saveActivityRuns([
      { ...fold(2)[0], status: 'complete', finishedAt: 9, summary: 'done' },
    ]);
    await flushMicrotasks();
    release();
    await Promise.all([...burst, finished]);

    const restored = await loadActivityRuns();
    expect(restored[0].status).toBe('complete');
    expect(restored[0].summary).toBe('done');
  });

  test('an idle list still removes the key, coalescing or not', async () => {
    mockSet.mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
    await saveActivityRuns(fold(1));
    expect(backing.has(ACTIVITY_RUNS_KEY)).toBe(true);

    await saveActivityRuns([]);
    expect(backing.has(ACTIVITY_RUNS_KEY)).toBe(false);
    expect(await loadActivityRuns()).toEqual([]);
  });
});
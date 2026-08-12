jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

import { normalizeRestoredRuns } from '@/lib/gateway/session-persistence';
import type { ActivityRun } from '@/lib/gateway/runs';

describe('normalizeRestoredRuns', () => {
  test('cancels in-flight runs after app restart', () => {
    const runs: ActivityRun[] = [
      {
        id: 'a',
        prompt: 'do thing',
        status: 'running',
        startedAt: 1,
        events: [],
      },
      {
        id: 'b',
        prompt: 'approve me',
        status: 'waiting-approval',
        startedAt: 2,
        events: [],
      },
      {
        id: 'c',
        prompt: 'done',
        status: 'complete',
        startedAt: 3,
        finishedAt: 4,
        events: [],
        summary: 'ok',
      },
    ];
    const next = normalizeRestoredRuns(runs);
    expect(next[0].status).toBe('cancelled');
    expect(next[1].status).toBe('cancelled');
    expect(next[2].status).toBe('complete');
    expect(next[0].summary).toMatch(/Interrupted/i);
  });
});

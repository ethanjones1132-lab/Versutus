jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

import { isLocalProvisionalRunId } from '@/lib/gateway/cancel';
import { normalizeRestoredRuns } from '@/lib/gateway/session-persistence';
import type { ActivityRun } from '@/lib/gateway/runs';

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

describe('normalizeRestoredRuns', () => {
  test('restores gateway-accepted in-flight runs as unresolved, not cancelled', () => {
    const next = normalizeRestoredRuns([
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', status: 'waiting-approval' }),
    ]);
    expect(next[0].status).toBe('unresolved');
    expect(next[1].status).toBe('unresolved');
    expect(next[0].summary).toMatch(/Interrupted/i);
    expect(next[1].summary).toMatch(/Interrupted/i);
    expect(next[0].finishedAt).toEqual(expect.any(Number));
  });

  test('keeps a local- provisional run cancelled — the gateway never saw it', () => {
    const next = normalizeRestoredRuns([
      run({ id: 'local-1234-abcd', status: 'running' }),
      run({ id: 'local-5678-efgh', status: 'waiting-approval' }),
    ]);
    expect(next[0].status).toBe('cancelled');
    expect(next[1].status).toBe('cancelled');
    expect(next[0].summary).toMatch(/Interrupted/i);
  });

  test('keeps an existing summary and finishedAt on a restored run', () => {
    const next = normalizeRestoredRuns([
      run({ id: 'run-9', status: 'running', summary: 'halfway there', finishedAt: 42 }),
    ]);
    expect(next[0].status).toBe('unresolved');
    expect(next[0].summary).toBe('halfway there');
    expect(next[0].finishedAt).toBe(42);
  });

  test('leaves finished runs byte-identical', () => {
    const finished: ActivityRun[] = [
      run({ id: 'c', status: 'complete', finishedAt: 4, summary: 'ok' }),
      run({ id: 'd', status: 'failed', finishedAt: 5, summary: 'boom' }),
      run({ id: 'e', status: 'cancelled', finishedAt: 6, summary: 'stopped' }),
      run({ id: 'f', status: 'unresolved', summary: 'unknown fate' }),
    ];
    const next = normalizeRestoredRuns(finished);
    expect(next).toEqual(finished);
  });

  test('shares the never-started predicate with the server-side cancel path', () => {
    expect(isLocalProvisionalRunId('local-1234-abcd')).toBe(true);
    expect(isLocalProvisionalRunId('run-1')).toBe(false);
  });
});

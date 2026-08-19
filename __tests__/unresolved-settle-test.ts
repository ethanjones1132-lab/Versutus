import { settleUnresolvedRuns, type ActivityRun } from '@/lib/gateway/runs';
import type { RunStatus } from '@/lib/gateway/types';

function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-1',
    prompt: 'do the thing',
    status: 'unresolved',
    startedAt: 1_000,
    events: [],
    ...overrides,
  };
}

function clientReturning(map: Record<string, RunStatus | Error>) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      getRunStatus: async (runId: string) => {
        calls.push(runId);
        const entry = map[runId];
        if (entry instanceof Error) throw entry;
        if (!entry) throw new Error(`no stub for ${runId}`);
        return entry;
      },
    },
  };
}

describe('settleUnresolvedRuns', () => {
  test('settles an unresolved run to complete when the gateway reports success', async () => {
    const { client, calls } = clientReturning({
      'run-1': { run_id: 'run-1', status: 'completed', result: 'all done' },
    });

    const { runs, changed } = await settleUnresolvedRuns(client, [run()]);

    expect(calls).toEqual(['run-1']);
    expect(runs[0].status).toBe('complete');
    expect(runs[0].summary).toBe('all done');
    expect(runs[0].finishedAt).toEqual(expect.any(Number));
    expect(changed).toHaveLength(1);
  });

  test('settles to failed and carries the error across', async () => {
    const { client } = clientReturning({
      'run-1': { run_id: 'run-1', status: 'error', error: 'boom' },
    });

    const { runs, changed } = await settleUnresolvedRuns(client, [run()]);

    expect(runs[0].status).toBe('failed');
    expect(runs[0].summary).toBe('boom');
    expect(changed).toHaveLength(1);
  });

  test('settles to cancelled', async () => {
    const { client } = clientReturning({
      'run-1': { run_id: 'run-1', status: 'aborted' },
    });

    const { runs } = await settleUnresolvedRuns(client, [run()]);
    expect(runs[0].status).toBe('cancelled');
  });

  test('leaves the run unresolved when the gateway is still not terminal', async () => {
    const { client } = clientReturning({
      'run-1': { run_id: 'run-1', status: 'running' },
    });

    const { runs, changed } = await settleUnresolvedRuns(client, [run()]);

    expect(runs[0].status).toBe('unresolved');
    expect(changed).toHaveLength(0);
  });

  test('a failing status probe leaves the run unresolved rather than inventing a result', async () => {
    const { client } = clientReturning({ 'run-1': new Error('network down') });

    const { runs, changed } = await settleUnresolvedRuns(client, [run()]);

    expect(runs[0].status).toBe('unresolved');
    expect(changed).toHaveLength(0);
  });

  test('never re-polls runs that already reached a terminal state', async () => {
    const { client, calls } = clientReturning({});

    const existing = [
      run({ id: 'a', status: 'complete' }),
      run({ id: 'b', status: 'failed' }),
      run({ id: 'c', status: 'cancelled' }),
      run({ id: 'd', status: 'running' }),
    ];
    const { runs, changed } = await settleUnresolvedRuns(client, existing);

    expect(calls).toEqual([]);
    expect(changed).toHaveLength(0);
    expect(runs.map((item) => item.status)).toEqual(['complete', 'failed', 'cancelled', 'running']);
  });

  test('settles only the unresolved entries and preserves list order', async () => {
    const { client, calls } = clientReturning({
      'run-2': { run_id: 'run-2', status: 'finished', result: 'ok' },
    });

    const { runs, changed } = await settleUnresolvedRuns(client, [
      run({ id: 'run-0', status: 'complete' }),
      run({ id: 'run-2', status: 'unresolved' }),
      run({ id: 'run-3', status: 'running' }),
    ]);

    expect(calls).toEqual(['run-2']);
    expect(runs.map((item) => item.id)).toEqual(['run-0', 'run-2', 'run-3']);
    expect(runs[1].status).toBe('complete');
    expect(changed.map((item) => item.id)).toEqual(['run-2']);
  });
});

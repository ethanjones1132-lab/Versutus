import { partitionRunsByState } from '../src/lib/activity/run-partition';
import type { ActivityRun } from '../src/lib/gateway/runs';

let nextId = 0;
const run = (status: ActivityRun['status']): ActivityRun => ({
  id: `run-${nextId++}`,
  prompt: 'do the thing',
  status,
  events: [],
  startedAt: 1_700_000_000_000,
});

const inFlight: ActivityRun['status'][] = ['running', 'waiting-approval'];
const settled: ActivityRun['status'][] = ['complete', 'failed', 'cancelled', 'unresolved'];

describe('partitionRunsByState', () => {
  it('partitions every status into in-flight and finished, in row order', () => {
    const statuses = [...inFlight, ...settled];
    const runs = statuses.map(run);
    const { inFlightRuns, finishedRuns } = partitionRunsByState(runs);
    expect(inFlightRuns.map((r) => r.status)).toEqual(inFlight);
    expect(finishedRuns.map((r) => r.status)).toEqual(settled);
  });

  it('is one pass: every run lands exactly once', () => {
    const runs = [run('running'), run('complete'), run('waiting-approval'), run('failed'), run('cancelled'), run('unresolved')];
    const { inFlightRuns, finishedRuns } = partitionRunsByState(runs);
    expect(inFlightRuns.length + finishedRuns.length).toBe(runs.length);
    expect([...inFlightRuns, ...finishedRuns].map((r) => r.id).sort()).toEqual(
      runs.map((r) => r.id).sort(),
    );
  });

  it('leaves the input untouched', () => {
    const runs = [run('running'), run('complete')];
    const { inFlightRuns, finishedRuns } = partitionRunsByState(runs);
    expect(runs.map((r) => r.status)).toEqual(['running', 'complete']);
    expect(inFlightRuns).not.toBe(runs);
    expect(finishedRuns).not.toBe(runs);
  });

  it('answers two empty arrays for an empty list', () => {
    const { inFlightRuns, finishedRuns } = partitionRunsByState([]);
    expect(inFlightRuns).toEqual([]);
    expect(finishedRuns).toEqual([]);
  });

  it('orders with the screen without reordering in-flight rows', () => {
    // In-flight above finished, active rows newest-last (push order), the way
    // the Activity listData fold consumed separate filter() arrays.
    const runs = [run('complete'), run('waiting-approval'), run('running'), run('failed')];
    const { inFlightRuns, finishedRuns } = partitionRunsByState(runs);
    expect(inFlightRuns.map((r) => r.status)).toEqual(['waiting-approval', 'running']);
    expect(finishedRuns.map((r) => r.status)).toEqual(['complete', 'failed']);
  });
});

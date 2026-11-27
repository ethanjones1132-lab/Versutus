import { partitionRunsByState, runIsInFlight } from '../src/lib/activity/run-partition';
import type { ActivityRun } from '../src/lib/gateway/runs';

let nextId = 0;
const run = (status: ActivityRun['status'], finishedAt?: number): ActivityRun => ({
  id: `run-${nextId++}`,
  prompt: 'do the thing',
  status,
  events: [],
  startedAt: 1_700_000_000_000,
  finishedAt,
});

const inFlight: ActivityRun['status'][] = ['running', 'waiting-approval', 'unresolved'];
const settled: ActivityRun['status'][] = ['complete', 'failed', 'cancelled', 'unresolved'];

describe('partitionRunsByState', () => {
  it('partitions every status into in-flight and finished, in row order', () => {
    const runs = [
      run('running'),
      run('waiting-approval'),
      run('unresolved'),
      run('complete'),
      run('failed'),
      run('cancelled'),
      run('unresolved', 1_700_000_500_000),
    ];
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

  it('a restored run whose fate was never learned is still going, not finished', () => {
    // `unresolved` with no finish of its own: the gateway may still be running
    // it, so Activity must keep it above the settled list — the same verdict
    // the glance and the drawer give it.
    const restored = run('unresolved');
    const learned = run('unresolved', 1_700_000_500_000);
    expect(runIsInFlight(restored)).toBe(true);
    expect(runIsInFlight(learned)).toBe(false);
    const { inFlightRuns, finishedRuns } = partitionRunsByState([restored, learned]);
    expect(inFlightRuns.map((r) => r.id)).toEqual([restored.id]);
    expect(finishedRuns.map((r) => r.id)).toEqual([learned.id]);
  });

  it('never calls a complete, failed or cancelled run in flight', () => {
    for (const status of ['complete', 'failed', 'cancelled'] as const) {
      expect(runIsInFlight(run(status))).toBe(false);
    }
  });
});

import { liveRunsForToday } from '@/lib/activity/today';
import type { ActivityRun } from '@/lib/gateway/runs';

const run = (id: string, status: ActivityRun['status'], finishedAt?: number): ActivityRun => ({
  id,
  prompt: id,
  status,
  startedAt: 1_800_000_000_000,
  finishedAt,
  events: [],
  gatewayId: 'gw-alpha',
});

describe("Today's In progress section", () => {
  test('keeps only the runs the shared verdict calls in flight', () => {
    const kept = liveRunsForToday([
      run('working', 'running'),
      run('waiting', 'waiting-approval'),
      run('done', 'complete'),
      run('failed', 'failed'),
      run('stopped', 'cancelled'),
      run('unknown', 'unresolved'),
      run('learned', 'unresolved', 1_800_000_500_000),
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(['working', 'waiting', 'unknown']);
  });

  test('keeps a restored run whose fate this device never learned', () => {
    // The pin this run updates: Today used to answer "unknown is not progress"
    // and drop the row while the glance, the drawer and Home called the same
    // restored row in flight. `runIsInFlight` is now the one answer on all four
    // surfaces; only a row carrying a learned finish is settled.
    const restored = run('restored', 'unresolved');
    const settled = run('settled', 'unresolved', 1_800_000_500_000);
    expect(liveRunsForToday([restored, settled]).map((entry) => entry.id)).toEqual(['restored']);
  });

  test('shows nothing rather than a stale row when every run has settled', () => {
    expect(liveRunsForToday([run('done', 'complete'), run('failed', 'failed')])).toEqual([]);
  });
});

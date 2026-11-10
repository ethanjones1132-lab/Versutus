import { liveRunsForToday } from '@/lib/activity/today';
import type { ActivityRun } from '@/lib/gateway/runs';

const run = (id: string, status: ActivityRun['status']): ActivityRun => ({
  id,
  prompt: id,
  status,
  startedAt: 1_800_000_000_000,
  events: [],
  gatewayId: 'gw-alpha',
});

describe("Today's In progress section", () => {
  test('keeps only the runs still moving or holding for the operator', () => {
    const kept = liveRunsForToday([
      run('working', 'running'),
      run('waiting', 'waiting-approval'),
      run('done', 'complete'),
      run('failed', 'failed'),
      run('stopped', 'cancelled'),
      run('unknown', 'unresolved'),
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(['working', 'waiting']);
  });

  test('shows nothing rather than a stale row when every run has settled', () => {
    expect(liveRunsForToday([run('done', 'complete'), run('failed', 'failed')])).toEqual([]);
  });
});

import { runStatusCopy, runsForGlance } from '@/lib/gateway/run-status-copy';
import type { ActivityRun } from '@/lib/gateway/runs';

function run(id: string, status: ActivityRun['status'], startedAt: number): ActivityRun {
  return { id, prompt: id, status, startedAt, events: [] };
}

describe('runStatusCopy', () => {
  test('every status reads in plain words, and only a waiting run asks for attention', () => {
    expect(runStatusCopy('running')).toEqual({ label: 'Working', tone: 'live' });
    expect(runStatusCopy('waiting-approval')).toEqual({ label: 'Waiting for you', tone: 'attention' });
    expect(runStatusCopy('complete')).toEqual({ label: 'Done', tone: 'done' });
    expect(runStatusCopy('failed')).toEqual({ label: 'Failed', tone: 'failed' });
    expect(runStatusCopy('cancelled')).toEqual({ label: 'Stopped', tone: 'quiet' });
    expect(runStatusCopy('unresolved')).toEqual({ label: 'Outcome unknown', tone: 'quiet' });
  });
});

describe('runsForGlance', () => {
  test('waiting runs lead, then working ones, then the newest finished', () => {
    const runs = [
      run('old-done', 'complete', 1),
      run('working', 'running', 5),
      run('new-done', 'complete', 9),
      run('waiting', 'waiting-approval', 2),
      run('failed', 'failed', 7),
    ];
    expect(runsForGlance(runs, 4).map((r) => r.id)).toEqual(['waiting', 'working', 'new-done', 'failed']);
  });

  test('the cap holds and never goes negative', () => {
    const runs = [run('a', 'complete', 1), run('b', 'complete', 2)];
    expect(runsForGlance(runs, 1).map((r) => r.id)).toEqual(['b']);
    expect(runsForGlance(runs, -3)).toEqual([]);
    // The input is not reordered in place.
    expect(runs.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

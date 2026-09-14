import { glanceableSnapshot, snapshotSignature } from '@/lib/widget/snapshot';
import { glanceableWidgetLines } from '@/lib/widget/widget-target';
import type { CronJob } from '@/lib/gateway/cron';
import type { ActivityRun } from '@/lib/gateway/runs';

const NOW = 1757400000000;

function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-1',
    prompt: 'do the thing',
    status: 'complete',
    startedAt: NOW - 600_000,
    finishedAt: NOW - 300_000,
    summary: 'wrote 3 files',
    events: [],
    ...overrides,
  };
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    title: 'morning briefing',
    lastRunAt: new Date(NOW - 60_000).toISOString(),
    lastStatus: 'ok',
    ...overrides,
  };
}

describe('glanceableSnapshot', () => {
  test('counts a live run and a waiting-approval run as in flight, and the wait as pending', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [
          run({ id: 'live', status: 'running', finishedAt: undefined, summary: undefined }),
          run({ id: 'stuck', status: 'waiting-approval', finishedAt: undefined, summary: undefined }),
        ],
        routines: [],
      },
      NOW,
    );

    expect(snapshot.runsInFlight).toBe(2);
    expect(snapshot.approvalsPending).toBe(1);
  });

  test('a settled run is never in flight', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [
          run({ id: 'a', status: 'complete' }),
          run({ id: 'b', status: 'failed', summary: 'boom' }),
          run({ id: 'c', status: 'cancelled', summary: 'stopped' }),
        ],
        routines: [],
      },
      NOW,
    );

    expect(snapshot.runsInFlight).toBe(0);
    expect(snapshot.approvalsPending).toBe(0);
  });

  test('a run this client stopped watching is over — not in flight, and no result', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'disconnected',
        // isTerminalRunStatus answers false for `unresolved` — it reads gateway
        // status strings — but the run is over and has no verdict to report.
        runs: [run({ status: 'unresolved', finishedAt: NOW - 1_000, summary: 'Interrupted when the app closed' })],
        routines: [],
      },
      NOW,
    );

    expect(snapshot.runsInFlight).toBe(0);
    expect(snapshot.lastResult).toBeUndefined();
  });

  test('the newest judged run contributes its own summary, in its own words', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [
          run({ id: 'old', status: 'complete', finishedAt: NOW - 500_000, summary: 'wrote 3 files' }),
          run({ id: 'new', status: 'failed', finishedAt: NOW - 1_000, summary: 'boom: bad token' }),
        ],
        routines: [],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBe('boom: bad token');
  });

  test('a judged run with no summary falls back to its own newest event preview', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [
          run({
            summary: undefined,
            events: [
              { type: 'run.started', preview: 'starting' },
              { type: 'run.completed', preview: 'result: 42' },
            ],
          }),
        ],
        routines: [],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBe('result: 42');
  });

  test('a run in flight never contributes a result', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [
          run({ id: 'live', status: 'running', finishedAt: undefined, summary: 'still going' }),
          run({ id: 'wait', status: 'waiting-approval', finishedAt: undefined, summary: 'waiting' }),
        ],
        routines: [],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBeUndefined();
  });

  test("a routine's own verdict label is the line when no judged run holds one", () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [job({ failureStreak: 2, lastError: 'token expired', lastStatus: 'error' })],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBe('Failing — 2 in a row');
  });

  test('a paused routine and one that never ran are states, not results', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [
          job({ id: 'paused', paused: true }),
          job({ id: 'never', lastRunAt: null, lastStatus: null }),
        ],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBeUndefined();
  });

  test('the newest routine judged is the one whose verdict is reported', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [
          job({ id: 'old', lastRunAt: new Date(NOW - 600_000).toISOString() }),
          job({
            id: 'new',
            lastRunAt: new Date(NOW - 60_000).toISOString(),
            lastDeliveryError: 'no channel',
          }),
        ],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBe('Ran, delivery failed');
  });

  test('across both kinds, the newest judged outcome is the one line', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [run({ finishedAt: NOW - 900_000, summary: 'wrote 3 files' })],
        routines: [job({ lastRunAt: new Date(NOW - 60_000).toISOString() })],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBe('ok');
  });

  test('a read that named nothing is an empty snapshot, not a zero-result line', () => {
    const snapshot = glanceableSnapshot({ status: 'connecting', runs: [], routines: [] }, NOW);

    expect(snapshot).toEqual({
      status: 'connecting',
      runsInFlight: 0,
      approvalsPending: 0,
      overdueRoutines: 0,
      routineAlerts: 0,
      writtenAt: NOW,
    });
    expect(snapshot.lastResult).toBeUndefined();
  });

  test('writtenAt is the now it was handed, so staleness is always sayable', () => {
    const snapshot = glanceableSnapshot({ status: 'connected', runs: [], routines: [] }, NOW - 5_000);

    expect(snapshot.writtenAt).toBe(NOW - 5_000);
  });
});

describe('routine alerts in the glanceable snapshot', () => {
  test('a job the health verdict judges error is counted as an alert', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [
          job({ failureStreak: 3, lastError: 'token expired', lastStatus: 'error' }),
          job({ id: 'healthy' }),
        ],
      },
      NOW,
    );

    expect(snapshot.routineAlerts).toBe(1);
    // The alert count and the verdict line come from the same judgment: the
    // failing job's verdict is still free to stand as the newest result.
    expect(snapshot.lastResult).toBe('Failing — 3 in a row');
  });

  test('a paused routine and a healthy one are not alerts', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [job({ id: 'paused', paused: true }), job({ id: 'fine' })],
      },
      NOW,
    );

    expect(snapshot.routineAlerts).toBe(0);
  });

  test('an alert count never displaces the newest judged verdict or an overdue count', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [run({ finishedAt: NOW - 60_000, summary: 'wrote 3 files' })],
        routines: [
          job({ failureStreak: 1, lastError: 'boom', lastStatus: 'error' }),
          job({ id: 'late', nextRunAt: new Date(NOW - 3_600_000).toISOString() }),
        ],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBe('wrote 3 files');
    expect(snapshot.overdueRoutines).toBe(1);
    expect(snapshot.routineAlerts).toBe(1);
  });
});

describe('snapshotSignature', () => {
  test('furniture-only drift between two folds carries the same signature', () => {
    // The write point re-folds on every poll-cycle patch to a run row or a
    // routine read; only facts the widget renders are news. A different
    // `writtenAt`, a renamed routine, a patched prompt and extra run events
    // move none of them.
    const earlier = glanceableSnapshot(
      {
        status: 'connected',
        runs: [run({ status: 'unresolved', finishedAt: undefined, summary: undefined })],
        routines: [job()],
      },
      NOW,
    );
    const later = glanceableSnapshot(
      {
        status: 'connected',
        runs: [
          {
            ...run({ status: 'unresolved', finishedAt: undefined, summary: undefined }),
            prompt: 'a renamed prompt the poll patched in',
            events: [{ type: 'run.completed', preview: 'a preview the poll appended' }],
          },
        ],
        routines: [job({ title: 'a renamed routine' })],
      },
      NOW + 40_000,
    );

    expect(snapshotSignature(later)).toBe(snapshotSignature(earlier));
  });

  test('each fact the widget renders moves the signature: status, in-flight, approvals, overdue, result', () => {
    const base = glanceableSnapshot({ status: 'connected', runs: [], routines: [] }, NOW);

    expect(snapshotSignature(base)).not.toBe(
      snapshotSignature(glanceableSnapshot({ status: 'connecting', runs: [], routines: [] }, NOW)),
    );
    expect(snapshotSignature(base)).not.toBe(
      snapshotSignature(
        glanceableSnapshot(
          {
            status: 'connected',
            runs: [run({ id: 'live', status: 'running', finishedAt: undefined, summary: undefined })],
            routines: [],
          },
          NOW,
        ),
      ),
    );
    expect(snapshotSignature(base)).not.toBe(
      snapshotSignature(
        glanceableSnapshot(
          {
            status: 'connected',
            runs: [run({ status: 'waiting-approval', finishedAt: undefined, summary: undefined })],
            routines: [],
          },
          NOW,
        ),
      ),
    );
    expect(snapshotSignature(base)).not.toBe(
      snapshotSignature(
        glanceableSnapshot(
          {
            status: 'connected',
            runs: [],
            routines: [job({ nextRunAt: new Date(NOW - 60_000).toISOString() })],
          },
          NOW,
        ),
      ),
    );
    expect(snapshotSignature(base)).not.toBe(
      snapshotSignature(
        glanceableSnapshot(
          { status: 'connected', runs: [run({ summary: 'wrote 3 files' })], routines: [] },
          NOW,
        ),
      ),
    );
    expect(snapshotSignature(base)).not.toBe(
      snapshotSignature(
        glanceableSnapshot(
          {
            status: 'connected',
            runs: [],
            routines: [job({ failureStreak: 1, lastError: 'boom', lastStatus: 'error' })],
          },
          NOW,
        ),
      ),
    );
  });
});

describe('overdue routines in the glanceable snapshot', () => {
  test('the job whose schedule is past and whose verdict is fresh carries the newest line exactly when nothing newer exists', () => {
    // The overdue job's own verdict is a valid judged outcome — a stalled
    // schedule is not "no work" — and an older routine verdict must not
    // displace a newer run's.
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [job({ nextRunAt: new Date(NOW - 6 * 3_600_000).toISOString() })],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBe('ok');
    expect(snapshot.overdueRoutines).toBe(1);
  });

  test('a schedule still held in the future and a job already running are not overdue', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [
          job({ id: 'ahead', nextRunAt: new Date(NOW + 3_600_000).toISOString() }),
          job({ id: 'running', nextRunAt: new Date(NOW - 3_600_000).toISOString(), running: true }),
        ],
      },
      NOW,
    );

    expect(snapshot.overdueRoutines).toBe(0);
  });

  test('a newer judged run outranks the overdue routine it follows', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [run({ finishedAt: NOW - 60_000, summary: 'wrote 3 files' })],
        routines: [job({ nextRunAt: new Date(NOW - 6 * 3_600_000).toISOString() })],
      },
      NOW,
    );

    expect(snapshot.lastResult).toBe('wrote 3 files');
    expect(snapshot.overdueRoutines).toBe(1);
  });
});

describe('overdue routines in the widget lines', () => {
  test('the work line carries the overdue suffix after the runs it counts', () => {
    expect(
      glanceableWidgetLines(
        glanceableSnapshot(
          {
            status: 'connected',
            runs: [run({ id: 'live', status: 'running', finishedAt: undefined, summary: undefined })],
            routines: [job({ nextRunAt: new Date(NOW - 6 * 3_600_000).toISOString() })],
          },
          NOW,
        ),
      ).work,
    ).toBe('1 run in flight · 1 routine overdue');
    expect(
      glanceableWidgetLines(
        glanceableSnapshot({ status: 'connected', runs: [], routines: [] }, NOW),
      ).work,
    ).toBe('No runs in flight');
  });
});

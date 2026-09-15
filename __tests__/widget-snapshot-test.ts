import { glanceableSnapshot } from '@/lib/widget/snapshot';
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

  test('in-flight runs are folded newest first, with their own words', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [
          run({ id: 'new', prompt: 'deploy the fix', status: 'waiting-approval', finishedAt: undefined, summary: undefined }),
          run({ id: 'old', prompt: 'index the repo\nand more', status: 'running', finishedAt: undefined, summary: undefined }),
        ],
        routines: [],
      },
      NOW,
    );
    expect(snapshot.runs).toEqual([
      { title: 'deploy the fix', state: 'Waiting for approval' },
      { title: 'index the repo', state: 'Running' },
    ]);
  });

  test('recent Bot Chats come first, the roster fills the rest, at most three', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [run({ id: 'r1', botId: 'beta' }), run({ id: 'r2', botId: 'alpha' })],
        routines: [],
        bots: [
          { id: 'alpha', label: 'Alpha' },
          { id: 'beta', label: 'Beta' },
          { id: 'gamma', label: 'Gamma' },
          { id: 'delta', label: 'Delta' },
        ],
      },
      NOW,
    );
    expect(snapshot.bots).toEqual([
      { id: 'beta', label: 'Beta' },
      { id: 'alpha', label: 'Alpha' },
      { id: 'gamma', label: 'Gamma' },
    ]);
  });

  test('a Bot the roster cannot label is carried as its own id', () => {
    const snapshot = glanceableSnapshot(
      { status: 'connected', runs: [run({ botId: 'mystery' })], routines: [], bots: [] },
      NOW,
    );
    expect(snapshot.bots).toEqual([{ id: 'mystery', label: 'mystery' }]);
  });

  test('a snapshot with no Bots omits them', () => {
    const snapshot = glanceableSnapshot({ status: 'connected', runs: [], routines: [] }, NOW);
    expect(snapshot).not.toHaveProperty('bots');
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
      writtenAt: NOW,
    });
    expect(snapshot.lastResult).toBeUndefined();
  });

  test('a late routine is one whose next run is due, not running, off, or unknown — tallied as routineAlerts', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [
          job({ id: 'late', nextRunAt: new Date(NOW - 60_000).toISOString(), lastStatus: 'ok' }),
          job({ id: 'current', nextRunAt: new Date(NOW + 600_000).toISOString(), lastStatus: 'ok' }),
          job({ id: 'busy', nextRunAt: new Date(NOW - 120_000).toISOString(), running: true, lastStatus: 'ok' }),
          job({ id: 'paused', nextRunAt: new Date(NOW - 120_000).toISOString(), paused: true }),
          job({ id: 'fresh', nextRunAt: new Date(NOW - 120_000).toISOString(), lastStatus: null }),
        ],
      },
      NOW,
    );

    expect(snapshot.routineAlerts).toEqual({ late: 1, failing: 0 });
  });

  test('a failing routine is one the gateway judges error — a warn is a warning, not failing', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [
          job({ id: 'failing', failureStreak: 1, lastError: 'token expired', lastStatus: 'error' }),
          job({ id: 'delivery', lastStatus: 'ok', lastDeliveryError: 'no channel' }),
          job({ id: 'bad', lastStatus: 'warned' }),
        ],
      },
      NOW,
    );

    expect(snapshot.routineAlerts).toEqual({ late: 0, failing: 1 });
  });

  test('a job can be both late and failing, and counts in both tallies', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [
          job({ id: 'both', nextRunAt: new Date(NOW - 60_000).toISOString(), failureStreak: 2, lastError: 'boom', lastStatus: 'error' }),
        ],
      },
      NOW,
    );

    expect(snapshot.routineAlerts).toEqual({ late: 1, failing: 1 });
  });

  test('routineAlerts is absent when no routine is late or failing', () => {
    const snapshot = glanceableSnapshot(
      {
        status: 'connected',
        runs: [],
        routines: [
          job({ id: 'fine', lastStatus: 'ok' }),
          job({ id: 'future', nextRunAt: new Date(NOW + 600_000).toISOString() }),
        ],
      },
      NOW,
    );
    const empty = glanceableSnapshot({ status: 'connecting', runs: [], routines: [] }, NOW);

    expect(snapshot).not.toHaveProperty('routineAlerts');
    expect(empty).not.toHaveProperty('routineAlerts');
  });

  test('writtenAt is the now it was handed, so staleness is always sayable', () => {
    const snapshot = glanceableSnapshot({ status: 'connected', runs: [], routines: [] }, NOW - 5_000);

    expect(snapshot.writtenAt).toBe(NOW - 5_000);
  });
});

import {
  CRON_RUN_FAILURE_MAX,
  cronJobSummary,
  cronRunSummary,
  cronRunVerdict,
  describeCronHealth,
  freshnessLabel,
  isRunLive,
  nextRunLabel,
  runElapsedLabel,
  runningCount,
  sortCronJobs,
  type CronJob,
  type CronRun,
} from '@/lib/gateway/cron';

const job = (over: Partial<CronJob> = {}): CronJob => ({ id: 'j', title: 'Job', ...over });

test('a running job says so above everything else', () => {
  // The one fact that changes what the operator does next.
  expect(cronJobSummary(job({ running: true, lastStatus: 'ok', nextRunAt: '2026-08-25T07:00:00Z' }))).toBe('running now');
});

test('health leads with the reason the next run will not happen', () => {
  // Paused is off on purpose, not failing — calling it a failure sends the
  // operator hunting a bug that does not exist.
  expect(describeCronHealth(job({ paused: true, pausedReason: 'manual' }))).toEqual({
    tone: 'off', label: 'Paused', detail: 'manual',
  });
  // A cooldown is the host throttling itself, and it outranks last_status
  // because it is what stops the next run.
  expect(describeCronHealth(job({ lastStatus: 'ok', cooldownReason: 'rate limited' }).valueOf() as CronJob).tone)
    .toBe('warn');
});

test('a failure streak reads as failing and carries the fix', () => {
  const one = describeCronHealth(job({ failureStreak: 1, lastError: 'bot "x" has no API_SERVER_KEY' }));
  expect(one.tone).toBe('error');
  expect(one.label).toBe('Last run failed');
  expect(one.detail).toMatch(/API_SERVER_KEY/);

  expect(describeCronHealth(job({ failureStreak: 4 })).label).toBe('Failing — 4 in a row');
});

test('a delivery failure is not a job failure', () => {
  // The work ran; only the delivery failed. Conflating them is a wrong diagnosis.
  const health = describeCronHealth(job({ lastStatus: 'ok', lastDeliveryError: 'discord 503' }));
  expect(health.tone).toBe('warn');
  expect(health.label).toBe('Ran, delivery failed');
});

test('a job that never ran is unknown, not healthy', () => {
  expect(describeCronHealth(job({}))).toEqual({ tone: 'unknown', label: 'Not run yet' });
});

test('next-run labels count down when near and give a clock time when far', () => {
  const now = Date.parse('2026-08-25T06:00:00Z');
  expect(nextRunLabel('2026-08-25T06:06:00Z', now)).toBe('in 6m');
  expect(nextRunLabel('2026-08-25T09:00:00Z', now)).toBe('in 3h');
  expect(nextRunLabel('2026-08-25T05:59:00Z', now)).toBe('due');
  // A timestamp the host wrote badly must not become a confident wrong promise.
  expect(nextRunLabel('not-a-date', now)).toBeNull();
});

test('elapsed time counts up while a run is live and freezes when it ends', () => {
  const now = 100_000;
  const live: CronRun = { id: 'r', jobId: 'j', status: 'running', turnCount: 1, startedAt: now - 75_000 };
  expect(runElapsedLabel(live, now)).toBe('1m 15s');
  expect(isRunLive(live)).toBe(true);

  const done: CronRun = { id: 'r', jobId: 'j', status: 'completed', turnCount: 4, startedAt: 0, finishedAt: 45_000 };
  expect(runElapsedLabel(done, now)).toBe('45s');
  expect(isRunLive(done)).toBe(false);

  // A host that reported no start gets silence, not a fabricated duration.
  expect(runElapsedLabel({ id: 'r', jobId: 'j', status: 'completed', turnCount: 0 }, now)).toBeNull();
});

test('a finished run the host never stamped does not keep counting up', () => {
  // The host closed the run but wrote no finishedAt. Measuring it against the
  // clock would make a finished run's duration grow on every re-render; the
  // duration is unknown, so the row prints none.
  const finished: CronRun = { id: 'r', jobId: 'j', status: 'completed', turnCount: 2, startedAt: 0 };
  expect(runElapsedLabel(finished, 45_000)).toBeNull();
  // The same run read a minute later is still unknown, not "1m 45s".
  expect(runElapsedLabel(finished, 105_000)).toBeNull();
  // An end stamp that is not a real number is equally unknown.
  expect(runElapsedLabel({ ...finished, finishedAt: Number.NaN }, 45_000)).toBeNull();

  // A live run still ticks: the same run measured later reads longer.
  const live: CronRun = { id: 'r', jobId: 'j', status: 'running', turnCount: 1, startedAt: 0 };
  expect(runElapsedLabel(live, 45_000)).toBe('45s');
  expect(runElapsedLabel(live, 105_000)).toBe('1m 45s');
  expect(isRunLive(finished)).toBe(false);
});

test('the freshness stamp always admits how stale the view is', () => {
  const now = 1_000_000;
  expect(freshnessLabel(null, now)).toBe('not loaded yet');
  expect(freshnessLabel(now - 1_000, now)).toBe('updated just now');
  expect(freshnessLabel(now - 12_000, now)).toBe('updated 12s ago');
  expect(freshnessLabel(now - 180_000, now)).toBe('updated 3m ago');
});

test('the list puts running first, then trouble, then the next thing due', () => {
  const now = Date.parse('2026-08-25T06:00:00Z');
  const sorted = sortCronJobs([
    job({ id: 'paused', title: 'Paused one', paused: true }),
    job({ id: 'healthy-late', title: 'Later', lastStatus: 'ok', nextRunAt: '2026-08-25T19:00:00Z' }),
    job({ id: 'broken', title: 'Broken', failureStreak: 3 }),
    job({ id: 'live', title: 'Live', running: true }),
    job({ id: 'healthy-soon', title: 'Sooner', lastStatus: 'ok', nextRunAt: '2026-08-25T07:00:00Z' }),
  ], now);
  expect(sorted.map((j) => j.id)).toEqual(['live', 'broken', 'healthy-soon', 'healthy-late', 'paused']);
});

test('the live badge counts only what is actually running', () => {
  expect(runningCount([job({ running: true }), job({}), job({ running: true })])).toBe(2);
  expect(runningCount([])).toBe(0);
});

test('an older Gate reporting nothing still renders a row', () => {
  // Degrade to unknown; never invent health the gateway did not report.
  const summary = cronJobSummary(job({}));
  expect(summary).toBe('Not run yet');
});

// ─── One run's row: a closed run is not automatically a success ────────────
// The wire only says a run is `running` or closed. A run the host reported an
// error for FAILED; rendering the closure as "completed" would tell the
// operator a scheduled job worked when it did not.

const run = (over: Partial<CronRun> = {}): CronRun => ({
  id: 'r',
  jobId: 'j',
  status: 'completed',
  turnCount: 3,
  ...over,
});

// The wire status is unvalidated, so a host word outside this build's two-value
// contract is exactly what these rows must survive.
const hostStatus = (word: string): CronRun['status'] => word as unknown as CronRun['status'];

test('a finished run the host reported an error for reads failed, never completed', () => {
  const failed = run({ status: 'completed', error: 'model "scout" is not configured\nRetry at the next schedule.' });
  expect(cronRunVerdict(failed)).toEqual({
    tone: 'failed',
    label: 'failed',
    detail: 'model "scout" is not configured Retry at the next schedule.',
  });
  const summary = cronRunSummary(failed);
  expect(summary.startsWith('failed · ')).toBe(true);
  // The host's message survives, flattened to the one line the row can hold.
  expect(summary).toContain('model "scout" is not configured Retry at the next schedule.');
  expect(summary).not.toContain('\n');
  expect(summary).not.toContain('completed');
});

test('a failure or cancellation word in the status is not read as success', () => {
  // The RPC payload is not validated, so a host that reports `failed` must not
  // fall through the old running/completed binary and print `completed`.
  const failed = cronRunVerdict(run({ status: hostStatus('failed') }));
  expect(failed).toEqual({ tone: 'failed', label: 'failed' });
  expect(cronRunSummary(run({ status: hostStatus('failed') }))).toBe('failed · 3 turns');

  const cancelled = cronRunVerdict(run({ status: hostStatus('cancelled') }));
  expect(cancelled).toEqual({ tone: 'failed', label: 'cancelled' });

  // A closed run still carries its duration where the host stamped one.
  const stamped = cronRunSummary(
    run({ status: hostStatus('error'), startedAt: 0, finishedAt: 12_000 }),
    60_000,
  );
  expect(stamped).toBe('failed · 12s · 3 turns');
  expect(stamped).not.toContain('completed');
});

test('a completion word is the only thing that reads completed', () => {
  expect(cronRunVerdict(run({ status: 'completed', startedAt: 0, finishedAt: 4_000 })))
    .toEqual({ tone: 'done', label: 'completed' });
  expect(cronRunSummary(run({ status: 'completed', startedAt: 1_000, finishedAt: 4_000 })))
    .toBe('completed · 3s · 3 turns');
  // A live run is still reported live, with its clock running.
  expect(cronRunSummary(run({ status: 'running', startedAt: 0, turnCount: 0 }), 45_000))
    .toBe('running · 45s · 0 turns');
});

test('a status word this build has never seen is repeated, never upgraded to success', () => {
  // Repeating the host's word is honest; inventing "completed" is not.
  const odd = cronRunVerdict(run({ status: hostStatus('quarantined') }));
  expect(odd).toEqual({ tone: 'unknown', label: 'quarantined' });
  expect(cronRunSummary(run({ status: hostStatus('quarantined') }))).not.toContain('completed');
  // No status at all is unknown, not a success.
  expect(cronRunVerdict(run({ status: hostStatus('') })))
    .toEqual({ tone: 'unknown', label: 'unknown' });
});

test('a blank error does not fail a run that completed cleanly', () => {
  // An empty error field is absent data, not a failure — the host wrote nothing.
  expect(cronRunVerdict(run({ error: '' })).tone).toBe('done');
  expect(cronRunVerdict(run({ error: '  \n\t ' })).tone).toBe('done');
  expect(cronRunVerdict(run({ error: null })).tone).toBe('done');
});

test('a failure reason is bounded to one line the row can hold', () => {
  const long = cronRunSummary(run({ error: 'x'.repeat(CRON_RUN_FAILURE_MAX * 2) }));
  expect(long.startsWith('failed · ')).toBe(true);
  expect(long.endsWith('…')).toBe(true);
  expect(long).toHaveLength('failed · '.length + CRON_RUN_FAILURE_MAX);
  expect(long).not.toContain('\n');
});

test('an error field the app cannot read still fails the run', () => {
  // The sheet cannot print a message it cannot parse, but a present error is
  // still a failure — silence about it would be a false success.
  const unreadable = run({ error: { message: 'boom' } as unknown as string });
  expect(cronRunVerdict(unreadable)).toEqual({ tone: 'failed', label: 'failed' });
  const summary = cronRunSummary(unreadable);
  expect(summary.startsWith('failed')).toBe(true);
  expect(summary).not.toContain('completed');
});

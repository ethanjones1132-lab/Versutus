import {
  cronJobSummary,
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

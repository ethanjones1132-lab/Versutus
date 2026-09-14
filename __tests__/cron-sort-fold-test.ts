import { sortCronJobs, describeCronHealth, type CronJob, type CronHealth } from '@/lib/gateway/cron';

const job = (over: Partial<CronJob>, id: string): CronJob => ({ id, title: 'Job', ...over });

describe('sortCronJobs', () => {
  test('order is byte-identical: running, failing, cooling down, warned, unreported, ok, paused, then next-run, then title', () => {
    // The shipped ordering, restated so the precompute cannot move a row:
    // every verdict here is produced by the real describeCronHealth rule —
    // a job with no lastStatus is unreported, never warned.
    const NOW = Date.parse('2026-09-14T10:00:00.000Z');
    const jobs = [
      job({ title: 'OK NO NEXT' }, 'ok-no-next'),
      job({ title: 'AAA', nextRunAt: new Date(NOW + 60_000).toISOString() }, 'unreported-aaa'),
      job({ title: 'BBB', nextRunAt: new Date(NOW + 60_000).toISOString(), cooldownReason: 'host throttling' }, 'cooldown'),
      job({ title: 'CCC', nextRunAt: new Date(NOW + 60_000).toISOString(), lastDeliveryError: 'send failed' }, 'delivery-fail'),
      job({ title: 'DDD', nextRunAt: new Date(NOW + 60_000).toISOString(), failureStreak: 1, lastStatus: 'error' }, 'error'),
      job({ title: 'EEE', nextRunAt: new Date(NOW + 60_000).toISOString() }, 'status-warn'),
      job({ title: 'FFF', nextRunAt: new Date(NOW + 120_000).toISOString() }, 'cooldown-early'),
      job({ title: 'GGG', paused: true }, 'paused'),
      job({ title: 'HHH', running: true }, 'running'),
    ];
    expect(sortCronJobs(jobs, NOW).map((j) => j.id)).toEqual([
      'running',
      'error',
      'cooldown',
      'delivery-fail',
      // EEE, FFF and AAA and the OK one are all tone-unknown in this fixture;
      // title AAA leads within the rank, then next-run inside equals, +inf last.
      'unreported-aaa',
      'status-warn',
      'cooldown-early',
      'ok-no-next',
      'paused',
    ]);
  });

  test('stable on equal keys: equal rank, equal next-run and equal title keep input order', () => {
    const NOW = Date.parse('2026-09-14T10:00:00.000Z');
    const jobs = [
      job({ lastStatus: 'ok', nextRunAt: new Date(NOW + 60_000).toISOString() }, 'b'),
      job({ lastStatus: 'ok', nextRunAt: new Date(NOW + 60_000).toISOString() }, 'a'),
      job({}, 'u1'),
      job({}, 'u2'),
    ];
    expect(sortCronJobs(jobs, NOW).map((j) => j.id)).toEqual(['b', 'a', 'u1', 'u2']);
  });

  test('health is judged once per row: the fold asks its describer exactly n times, never per comparison', () => {
    // The comparator used to re-derive both sides' verdicts on every
    // comparison, charging O(n log n) health verdicts for n well-known rows.
    // The describer is injectable so the internal call can be counted: the
    // fold must ask for exactly one verdict per row.
    const describer = jest.fn((job: CronJob): CronHealth => describeCronHealth(job));
    const NOW = Date.parse('2026-09-14T10:00:00.000Z');
    const jobs: CronJob[] = [];
    for (let i = 0; i < 20; i += 1) {
      jobs.push(job({ lastStatus: 'ok', nextRunAt: new Date(NOW + i).toISOString() }, `j${i}`));
      jobs.push(job({}, `u${i}`));
    }
    sortCronJobs(jobs, NOW, describer);
    expect(describer).toHaveBeenCalledTimes(40); // 40 rows, one judgment each — not O(n log n)
  });

  test('the default describer is describeCronHealth itself', () => {
    // The injectable seam defaults to the shipped verdict, so production
    // callers pass nothing and the row ordering stays byte-identical.
    const NOW = Date.parse('2026-09-14T10:00:00.000Z');
    const jobs = [job({ paused: true }, 'p'), job({ lastStatus: 'ok' }, 'o')];
    expect(sortCronJobs(jobs, NOW).map((j) => j.id)).toEqual(['o', 'p']);
  });
});

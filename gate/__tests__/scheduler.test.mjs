import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nextCronRun, parseCron } from '../core/scheduler/cron.mjs';
import { createRoutineScheduler } from '../core/scheduler/index.mjs';

test('cron parser supports steps, lists, ranges, and Sunday as either 0 or 7', () => {
  const parsed = parseCron('*/15 8,10-11 1-5 1,6 0,7');
  assert.deepEqual([...parsed[0].values].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...parsed[1].values].sort((a, b) => a - b), [8, 10, 11]);
  assert.deepEqual([...parsed[4].values], [0]);
  assert.throws(() => parseCron('0 1 * *'), /five fields/);
  assert.throws(() => parseCron('61 * * * *'), /between/);
});

test('next run uses local calendar fields and respects day-of-week across DST', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // Sunday after the spring-forward gap: the expression remains at 03:30
    // local, and the weekday predicate is evaluated in local time.
    const next = nextCronRun('30 3 * * 0', new Date('2026-03-08T06:59:00.000Z'));
    assert.equal(next.toString().includes('03:30:00'), true);
    assert.equal(next.getDay(), 0);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('scheduler persists CRUD and records errors and timeout outcomes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-scheduler-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = new Date('2026-01-01T00:00:00.000Z').getTime();
  let execute = async () => ({ output: 'done' });
  const make = () => createRoutineScheduler({
    directory,
    environmentId: 'claude-local',
    botId: 'research',
    execute: (...args) => execute(...args),
    now: () => clock,
    tickMs: 60_000,
    runTimeoutMs: 5,
  });
  let scheduler = make();
  const created = await scheduler.createJob({ name: 'Nightly', prompt: 'Summarize', schedule: '* * * * *' });
  assert.equal(created.enabled, true);
  scheduler = make();
  assert.equal((await scheduler.listJobs()).jobs[0].id, created.id);
  const ok = await scheduler.runJob(created.id);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.output, 'done');

  execute = async () => { throw new Error('backend refused'); };
  const failed = await scheduler.runJob(created.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'backend refused');

  execute = async () => new Promise(() => {});
  const timedOut = await scheduler.runJob(created.id);
  assert.equal(timedOut.status, 'error');
  assert.match(timedOut.error, /timed out/);

  await scheduler.setJobPaused(created.id, true);
  assert.equal((await scheduler.listJobs()).jobs[0].enabled, false);
  await scheduler.setJobPaused(created.id, false);
  await scheduler.updateJob(created.id, { name: 'Updated' });
  assert.equal((await scheduler.listJobs()).jobs[0].name, 'Updated');
  assert.deepEqual((await scheduler.listJobs()).jobs[0].history.map((row) => row.status), ['error', 'error', 'ok']);
  await scheduler.removeJob(created.id);
  assert.deepEqual((await scheduler.listJobs()).jobs, []);
});

test('restart runs at most one overdue job and marks it as a catch-up', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-scheduler-catchup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = new Date('2026-01-01T00:00:00.000Z').getTime();
  const jobs = [];
  const make = () => createRoutineScheduler({
    directory,
    environmentId: 'codex-local',
    execute: async (_job, options) => { jobs.push(options); return { output: 'caught up' }; },
    now: () => clock,
  });
  const first = make();
  const job = await first.createJob({ name: 'Every minute', prompt: 'Run', schedule: '* * * * *' });
  clock += 10 * 60_000;
  await make().start();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].catchUp, true);
  assert.equal((await make().listJobs()).jobs.find((row) => row.id === job.id).history.length, 1);
});

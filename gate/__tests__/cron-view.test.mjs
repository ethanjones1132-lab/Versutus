import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCronSessionId,
  parseRoutineOwner,
  runsForJob,
  toCronJobView,
  toCronRunView,
} from '../core/cron-view.mjs';

// Hermes names every cron run's session `cron_<jobId>_<yyyymmdd>_<hhmmss>`.
// That convention is the only link between a job and its transcripts, and it
// is a HOST convention — decoded here so the app never has to know it.

test('a cron session id yields its job and start time', () => {
  const parsed = parseCronSessionId('cron_934a7d7ff88c_20260824_180021');
  assert.equal(parsed.jobId, '934a7d7ff88c');
  assert.equal(parsed.at, '20260824_180021');
});

test('ids that are not cron runs decode to null, never a guess', () => {
  for (const id of ['api_1787256183_54a46d4a', '20260824_221245_7a9be4', 'cron_', 'cron_abc', '', null]) {
    assert.equal(parseCronSessionId(id), null, `should not parse: ${id}`);
  }
});

test('runs for a job are its own, newest first', () => {
  const sessions = [
    { id: 'cron_aaa_20260824_180021', message_count: 3, started_at: 3 },
    { id: 'cron_bbb_20260824_190000', message_count: 9, started_at: 9 },
    { id: 'cron_aaa_20260823_180021', message_count: 5, started_at: 1 },
    { id: 'api_123_abc', message_count: 1, started_at: 2 },
  ];
  const runs = runsForJob('aaa', sessions);
  assert.deepEqual(runs.map((r) => r.id), ['cron_aaa_20260824_180021', 'cron_aaa_20260823_180021']);
  assert.equal(runs[0].jobId, 'aaa');
  assert.equal(runs[0].turnCount, 3);
});

test('a job with no runs is an empty list, not an error', () => {
  assert.deepEqual(runsForJob('nobody', [{ id: 'cron_aaa_20260824_180021' }]), []);
});

test('a run view reports finished vs still running', () => {
  const finished = toCronRunView({ id: 'cron_aaa_20260824_180021', message_count: 4, ended_at: 200, started_at: 100 });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.finishedAt, 200);

  const live = toCronRunView({ id: 'cron_aaa_20260824_180021', message_count: 2, ended_at: null, started_at: 100 });
  assert.equal(live.status, 'running');
  assert.equal(live.finishedAt, null);
});

test('the [bot:name] convention names the Bot that owns a routine', () => {
  assert.deepEqual(parseRoutineOwner('[bot:herald] Herald - Daily Pick'), {
    botId: 'herald',
    title: 'Herald - Daily Pick',
  });
  // A plain job belongs to no Bot — say so rather than inventing one.
  assert.deepEqual(parseRoutineOwner('Guardian Agent v2'), { botId: null, title: 'Guardian Agent v2' });
  assert.deepEqual(parseRoutineOwner(undefined), { botId: null, title: '' });
});

test('a job view leads with the curated fields and keeps the raw record', () => {
  const job = {
    id: '934a7d7ff88c',
    name: '[bot:herald] Guardian Agent v2',
    prompt: 'x'.repeat(4000),
    model: null,
    provider: null,
    schedule: '0 7,10,14,18 * * *',
    schedule_display: 'daily at 07:00, 10:00, 14:00, 18:00',
    enabled: true,
    state: 'scheduled',
    next_run_at: '2026-08-25T07:00:00-04:00',
    last_run_at: '2026-08-24T18:00:21-04:00',
    last_status: 'ok',
    failure_streak: 0,
    enabled_toolsets: ['hermes-cli'],
    workdir: 'C:\\Projects\\.hermes',
    deliver: 'auto',
    origin: 'builtin',
    latest_execution: { status: 'completed', started_at: 'a', finished_at: 'b', error: null },
  };
  const view = toCronJobView(job);

  assert.equal(view.id, '934a7d7ff88c');
  assert.equal(view.title, 'Guardian Agent v2');
  assert.equal(view.botId, 'herald');
  assert.equal(view.scheduleDisplay, 'daily at 07:00, 10:00, 14:00, 18:00');
  assert.equal(view.lastStatus, 'ok');
  assert.equal(view.running, false);
  assert.deepEqual(view.toolsets, ['hermes-cli']);
  assert.equal(view.workdir, 'C:\\Projects\\.hermes');
  // The prompt travels — it is the whole point of transparency — but the
  // client is told how big it is so it can collapse without measuring.
  assert.equal(view.promptLength, 4000);
  assert.equal(view.prompt.length, 4000);
  // Raw is the untouched record, so "show raw" can never be a curated lie.
  assert.equal(view.raw, job);
});

test('a running job is flagged from its latest execution', () => {
  const view = toCronJobView({
    id: 'j1', name: 'busy', latest_execution: { status: 'running', started_at: 'a', finished_at: null },
  });
  assert.equal(view.running, true);
  assert.equal(view.latestExecution.status, 'running');
});

test('an older Gate reporting almost nothing still yields a usable view', () => {
  // Degrade, never throw: absent fields read as unknown, not as false claims.
  const view = toCronJobView({ id: 'j2' });
  assert.equal(view.id, 'j2');
  assert.equal(view.title, '');
  assert.equal(view.botId, null);
  assert.equal(view.running, false);
  assert.equal(view.lastStatus, null);
  assert.deepEqual(view.toolsets, []);
  assert.equal(view.promptLength, 0);
});

test('a job id is required to view anything', () => {
  assert.equal(toCronJobView(null), null);
  assert.equal(toCronJobView({}), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayMethods } from '../core/capabilities/gateway-methods.mjs';

// Every backend can list sessions and messages; only one runs cron. Resolving
// these surfaces on `listSessions`/`listMessages` picks whichever environment
// sorts first — Claude Code on a typical Gate — and answers with ITS
// transcripts, which contain no cron runs at all. Observed live 2026-08-25:
// cron.runs returned 0 for a job with 21 real runs.

/** A backend that can list sessions but knows nothing about cron. */
const plain = {
  async listSessions() { return [{ id: 'api_1_abc', message_count: 1 }]; },
  async listMessages() { return [{ id: 'm0', role: 'user', content: 'not a cron run' }]; },
};

/** The environment that actually owns the jobs. */
const cronCapable = {
  async listJobs() { return { data: [{ id: 'job1', name: '[bot:herald] Daily Pick' }] }; },
  async listSessions() {
    return [
      { id: 'cron_job1_20260824_180021', message_count: 4, ended_at: 2, started_at: 1 },
      { id: 'cron_job1_20260823_180021', message_count: 2, ended_at: 2, started_at: 1 },
      { id: 'cron_other_20260824_090000', message_count: 9, ended_at: 2, started_at: 1 },
    ];
  },
  async listMessages() {
    return [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ran the job' }] }];
  },
};

/** Mimics resolveBackendFor: hand back the first backend implementing `name`. */
function getBackend(_backendId, name) {
  for (const backend of [plain, cronCapable]) {
    if (typeof backend[name] === 'function') return backend;
  }
  throw new Error(`no backend implements ${name}`);
}

const methods = createGatewayMethods({ getBackend });

test('cron.runs reads the environment that owns the jobs, not the first session lister', async () => {
  const result = await methods['cron.runs']({ jobId: 'job1' });
  assert.equal(result.data.length, 2, 'both of job1\'s runs, and only job1\'s');
  assert.deepEqual(
    result.data.map((run) => run.id),
    ['cron_job1_20260824_180021', 'cron_job1_20260823_180021'],
  );
});

test('cron.transcript reads from the cron environment too', async () => {
  const result = await methods['cron.transcript']({ runId: 'cron_job1_20260824_180021' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].text, 'ran the job');
});

test('cron.jobs curates the cron backend\'s records', async () => {
  const result = await methods['cron.jobs']({});
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].title, 'Daily Pick');
  assert.equal(result.data[0].botId, 'herald');
});

test('a run id that is not a cron run is refused before any backend call', async () => {
  await assert.rejects(
    () => methods['cron.transcript']({ runId: 'api_1787256183_54a46d4a' }),
    /is not a cron run id/,
  );
});

test('cron.runs without a job id fails loudly', async () => {
  await assert.rejects(() => methods['cron.runs']({}), /jobId is required/);
});

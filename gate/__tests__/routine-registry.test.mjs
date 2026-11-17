import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGatewayMethods } from '../core/capabilities/gateway-methods.mjs';
import { createRoutineRegistry } from '../core/scheduler/registry.mjs';

test('scheduled environments stay stopped for routine management and start only when a job fires', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-routine-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = new Date('2026-01-01T00:00:00.000Z').getTime();
  let backendStarts = 0;
  const turns = [];
  const registry = createRoutineRegistry({
    directory,
    listEnvironments: async () => [{ id: 'claude-local', adapterId: 'claude-code', enabled: true }],
    getBackend: async () => {
      backendStarts += 1;
      return { async createSession() { return { id: 'routine-session' }; } };
    },
    runTurn: async (_backend, sessionId, prompt) => {
      turns.push({ sessionId, prompt });
      return { output: 'routine output' };
    },
    now: () => clock,
    setTimer: () => ({ unref() {} }),
  });

  await registry.startAll();
  const methods = createGatewayMethods({
    getBackend: async () => {
      backendStarts += 1;
      throw new Error('scheduled management must not resolve a backend');
    },
    routineScheduler: (params) => params?.backendId === 'claude-local'
      ? registry.forEnvironment('claude-local', params?.botId ?? null)
      : null,
  });
  const rpcJob = await methods['jobs.create']({
    backendId: 'claude-local',
    botId: 'writer',
    name: 'Temporary',
    prompt: 'Temporary prompt',
    schedule: '* * * * *',
  });
  assert.equal((await methods['cron.list']({ backendId: 'claude-local', botId: 'writer' })).jobs[0].id, rpcJob.id);
  await methods['jobs.pause']({ backendId: 'claude-local', botId: 'writer', jobId: rpcJob.id });
  await methods['jobs.resume']({ backendId: 'claude-local', botId: 'writer', jobId: rpcJob.id });
  await methods['jobs.remove']({ backendId: 'claude-local', botId: 'writer', jobId: rpcJob.id });
  assert.equal(backendStarts, 0);
  const scheduler = await registry.forEnvironment('claude-local');
  const job = await scheduler.createJob({
    name: 'Morning summary',
    prompt: 'Summarize the latest work',
    schedule: '* * * * *',
  });
  await scheduler.listJobs();
  await scheduler.setJobPaused(job.id, true);
  await scheduler.setJobPaused(job.id, false);
  await scheduler.removeJob(job.id);
  const restored = await scheduler.createJob({
    name: 'Morning summary',
    prompt: 'Summarize the latest work',
    schedule: '* * * * *',
  });
  assert.equal(backendStarts, 0);

  clock += 60_000;
  await scheduler.tick();

  assert.equal(backendStarts, 1);
  assert.deepEqual(turns, [{
    sessionId: 'routine-session',
    prompt: 'Summarize the latest work',
  }]);
  const history = (await scheduler.listJobs()).jobs.find((entry) => entry.id === restored.id).history;
  assert.equal(history[0].status, 'ok');
  assert.equal(history[0].output, 'routine output');
  const runs = await methods['cron.runs']({ backendId: 'claude-local', jobId: restored.id });
  assert.equal(runs.data[0].status, 'completed');
  assert.equal(runs.data[0].output, 'routine output');
  await registry.stopAll();
});

test('only the supported CLI adapters use Gate-owned routine schedulers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-routine-registry-adapters-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = [
    { id: 'hermes-local', adapterId: 'hermes' },
    { id: 'fake-local', adapterId: 'test-fake' },
    { id: 'codex-local', adapterId: 'codex' },
  ];
  const registry = createRoutineRegistry({
    directory,
    listEnvironments: async () => records,
    getBackend: async () => {
      throw new Error('the backend must not be started by adapter detection');
    },
    runTurn: async () => ({ output: '' }),
    setTimer: () => ({ unref() {} }),
  });

  assert.equal(await registry.isScheduled('hermes-local'), false);
  assert.equal(await registry.forEnvironment('hermes-local'), null);
  assert.equal(await registry.isScheduled('fake-local'), false);
  assert.equal(await registry.forEnvironment('fake-local'), null);
  assert.ok(await registry.forEnvironment('codex-local'));
  await registry.stopAll();
});

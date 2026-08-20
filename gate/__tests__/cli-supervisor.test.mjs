import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { fakeExecutable } from './fixtures/cli-protocols/fake-executable.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

async function makeService(overrides = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-cli-sup-'));
  const store = new CliEnvironmentStore(gateHome);
  const executable = await fakeExecutable('0.142.1');
  const record = validEnvironment({
    id: 'codex-local',
    adapterId: 'codex',
    executable: { path: executable },
    workspacePolicy: {
      roots: [gateHome],
      defaultRoot: gateHome,
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
    ...overrides,
  });
  await store.put(record);
  const jobs = [];
  const service = new CliEnvironmentService({
    store,
    registry: new CliAdapterRegistry(),
    jobFactory: () => {
      const job = {
        terminated: false,
        async terminate() { job.terminated = true; },
      };
      jobs.push(job);
      return job;
    },
  });
  return { service, gateHome, jobs, cleanup: () => rm(gateHome, { recursive: true, force: true }) };
}

test('startRun emits a started event and one terminal event', async () => {
  const { service, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    const events = [];
    for await (const event of service.events(handle.runId)) {
      events.push(event);
    }
    assert.equal(events[0].type, 'run.started');
    assert.equal(events.filter((event) => /completed|failed|cancelled/.test(event.type)).length, 1);
    assert.deepEqual(events.map((event, index) => event.sequence), events.map((_, index) => index + 1));
  } finally {
    await cleanup();
  }
});

test('cancel terminates the job and emits run.cancelled once', async () => {
  const { service, jobs, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
      hang: true,
    });
    await service.cancel(handle.runId);
    const events = [];
    for await (const event of service.events(handle.runId)) {
      events.push(event);
    }
    assert.equal(events.filter((event) => event.type === 'run.cancelled').length, 1);
    assert.equal(jobs[0].terminated, true);
  } finally {
    await cleanup();
  }
});

test('concurrent runs honor maxConcurrentRuns', async () => {
  const { service, cleanup } = await makeService({
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 30, maxConcurrentRuns: 1 },
  });
  try {
    await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
      hang: true,
    });
    await assert.rejects(() => service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    }), /busy|concurrent/i);
  } finally {
    await cleanup();
  }
});

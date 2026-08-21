import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { fakeRunner } from './fixtures/cli-protocols/fake-runner.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

async function collectEvents(service, runId) {
  const events = [];
  for await (const event of service.events(runId)) events.push(event);
  return events;
}

async function makeService(overrides = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-cli-sup-'));
  const store = new CliEnvironmentStore(gateHome);
  const executable = await fakeRunner('0.142.1');
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
  const children = [];
  const service = new CliEnvironmentService({
    store,
    registry: new CliAdapterRegistry(),
    jobFactory: () => {
      const job = {
        terminated: false,
        children: [],
        add(child) { job.children.push(child); },
        async terminate() {
          job.terminated = true;
          for (const child of job.children) child.kill();
        },
      };
      jobs.push(job);
      return job;
    },
    spawnImpl: (command, args, options) => {
      // The real spawn, observed so tests can hold a handle to the child.
      // execute() spawns synchronously inside startRun, so by the time
      // startRun resolves the handle is here.
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    },
  });
  return {
    service,
    gateHome,
    jobs,
    children,
    cleanup: () => {
      const exits = children.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) resolve();
        else {
          child.once('exit', () => resolve());
          // A kill can lag on Windows; never let a test hang on it.
          setTimeout(resolve, 2000).unref?.();
        }
      }));
      for (const child of children) {
        try { child.kill(); } catch { /* already gone */ }
      }
      // The spawned child holds its cwd (the temp workspace), so Windows
      // reports EBUSY if the rmdir races the process dying.
      return Promise.all(exits)
        .then(() => rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    },
  };
}

test('a status run really executes the CLI and completes once', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    assert.equal(children.length, 1, 'even a status run spawns the executable');
    const events = await collectEvents(service, handle.runId);
    assert.equal(events[0].type, 'run.started');
    assert.equal(events.filter((event) => /completed|failed|cancelled/.test(event.type)).length, 1);
    assert.deepEqual(events.map((event, index) => event.sequence), events.map((_, index) => index + 1));
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.completed');
    assert.equal(terminal.payload.exitCode, 0);
  } finally {
    await cleanup();
  }
});

test('a prompt run streams the reply as run.output events before completing', async () => {
  const { service, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'say hello world back' },
    });
    const events = await collectEvents(service, handle.runId);
    const outputs = events.filter((event) => event.type === 'run.output');
    assert.ok(outputs.length > 0, 'the reply must arrive as streamed output, not only a terminal event');
    const joined = outputs.map((event) => event.payload.text).join('');
    assert.ok(joined.includes('hello world back'), `output should carry the reply, got: ${joined}`);
    const terminalIndex = events.findIndex((event) => /completed|failed|cancelled/.test(event.type));
    for (const output of outputs) {
      assert.ok(events.indexOf(output) < terminalIndex, 'output must precede the terminal event');
    }
    assert.equal(events.at(-1).type, 'run.completed');
  } finally {
    await cleanup();
  }
});

test('a nonzero exit surfaces as run.failed with the code and stderr text', async () => {
  const { service, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'please FAIL loudly' },
    });
    const events = await collectEvents(service, handle.runId);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.failed');
    assert.equal(terminal.payload.exitCode, 3);
    const stderrText = events
      .filter((event) => event.type === 'run.output' && event.payload.stream === 'stderr')
      .map((event) => event.payload.text)
      .join('');
    assert.ok(stderrText.includes('runner refused'), 'stderr must reach the operator, not vanish');
  } finally {
    await cleanup();
  }
});

test('an operation with no non-interactive invocation fails honestly, not with an empty success', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'interactive',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { command: 'vim' },
    });
    const events = await collectEvents(service, handle.runId);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.failed');
    assert.match(terminal.payload.message, /interactive/);
    assert.equal(events.filter((event) => event.type === 'run.completed').length, 0);
    assert.equal(children.length, 0, 'nothing is spawned when there is no invocation contract');
  } finally {
    await cleanup();
  }
});

test('cancel kills the spawned child and emits run.cancelled once', async () => {
  const { service, jobs, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'SLEEP:30000' },
    });
    assert.equal(children.length, 1, 'a prompt run must spawn a real child process');
    const result = await service.cancel(handle.runId);
    assert.equal(result.cancelled, true);
    const events = await collectEvents(service, handle.runId);
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
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'SLEEP:30000' },
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

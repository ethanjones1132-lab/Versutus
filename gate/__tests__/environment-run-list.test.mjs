import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';
import { fakeExecutable } from './fixtures/cli-protocols/fake-executable.mjs';
import { fakeRunner } from './fixtures/cli-protocols/fake-runner.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

/**
 * Recovery path for a dropped stream: the phone must be able to rediscover a
 * run after the SSE connection is gone. The event endpoint already replays
 * from sequence 0; this route is what hands back the run id to replay.
 */
async function setupGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-env-run-list-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const gateHome = join(root, '.gate-home');
  const gate = await createGate({ root, port: 0, gateHome });
  const executable = await fakeExecutable('0.142.1');
  await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({
      method: 'environments.create',
      params: validEnvironment({
        id: 'codex-local',
        adapterId: 'codex',
        executable: { path: executable },
        workspacePolicy: {
          roots: [root],
          defaultRoot: root,
          defaultSandbox: 'read_only',
          allowAdditionalRoots: false,
        },
      }),
    }),
  });
  return gate;
}

async function startRun(gate) {
  const started = await fetch(`http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ operation: 'status', input: {} }),
  });
  assert.equal(started.status, 200);
  const { runId } = await started.json();
  return runId;
}

async function listRuns(gate, environmentId = 'codex-local') {
  return fetch(`http://127.0.0.1:${gate.port}/v1/environments/${environmentId}/runs`, {
    headers: { Authorization: `Bearer ${gate.token}` },
  });
}

// Same direct-service harness as cli-supervisor.test.mjs: the state between
// startRun and the first event is real but too short-lived to hit over HTTP.
async function collectEvents(service, runId) {
  const events = [];
  for await (const event of service.events(runId)) events.push(event);
  return events;
}

async function makeService() {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-env-run-list-svc-'));
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
  });
  await store.put(record);
  const children = [];
  const service = new CliEnvironmentService({
    store,
    registry: new CliAdapterRegistry(),
    jobFactory: () => ({
      children: [],
      add(child) {
        this.children.push(child);
      },
      async terminate() {
        for (const child of this.children) child.kill();
      },
    }),
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    },
  });
  return {
    service,
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
      return Promise.all(exits)
        .then(() => rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    },
  };
}

test('run listing returns completed runs newest first with terminal state', async () => {
  const gate = await setupGate();
  try {
    // One at a time: maxConcurrentRuns is 1, so run 2 starts only after
    // run 1 has drained to its terminal event.
    const firstRunId = await startRun(gate);
    await fetch(
      `http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs/${firstRunId}/events`,
      { headers: { Authorization: `Bearer ${gate.token}` } },
    ).then((response) => response.text());
    const secondRunId = await startRun(gate);
    await fetch(
      `http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs/${secondRunId}/events`,
      { headers: { Authorization: `Bearer ${gate.token}` } },
    ).then((response) => response.text());

    const response = await listRuns(gate);
    assert.equal(response.status, 200);
    const { runs } = await response.json();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((run) => run.runId), [secondRunId, firstRunId]);
    for (const run of runs) {
      assert.equal(run.environmentId, 'codex-local');
      assert.equal(run.operation, 'status');
      assert.equal(run.state, 'completed');
      assert.equal(run.exitCode, 0);
      assert.ok(run.startedAt, 'startedAt present');
      assert.ok(run.endedAt, 'endedAt present for a finished run');
    }
    assert.ok(new Date(runs[0].startedAt) >= new Date(runs[1].startedAt));
  } finally {
    await gate.close();
  }
});

test('a run that has not finished reports a live state, and a finished one its outcome', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      input: {},
    });
    const [summary] = service.listRuns('codex-local');
    assert.equal(summary.runId, handle.runId);
    assert.ok(['starting', 'running'].includes(summary.state));
    assert.equal(summary.endedAt, null);
    // A mid-flight run advertises the OS pid actually doing the work, so an
    // operator (and smoke:wedge) can identify it — and prove a cancelled one
    // dead — outside the Gate's own bookkeeping.
    assert.equal(summary.pid, children[0].pid);
    await collectEvents(service, handle.runId);
    const [after] = service.listRuns('codex-local');
    assert.equal(after.state, 'completed');
    assert.equal(after.exitCode, 0);
    // Finished runs stop advertising: a stale pid must never read as live.
    assert.equal(after.pid, null);
    assert.equal(children.length, 1);
  } finally {
    await cleanup();
  }
});

test('listing runs of an unknown environment is a 404, not an empty list', async () => {
  const gate = await setupGate();
  try {
    const response = await listRuns(gate, 'no-such-environment');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'environment_not_found');
  } finally {
    await gate.close();
  }
});

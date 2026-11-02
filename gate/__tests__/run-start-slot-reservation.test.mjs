import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

// The concurrency limit lives on the environment record, which startRun only
// reads after its first await. Two starts arriving together therefore used to
// both see the same free slot: with maxConcurrentRuns 1 they both registered a
// run and both spawned. The supervisor now takes a ticket synchronously on
// entry and refuses a start that has an unreserved slot in front of it, so the
// gap between the limit check and the registration is never a hole.

const ENVIRONMENT_ID = 'codex-local';

function deferred() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

async function makeService({ maxConcurrentRuns = 1, probe } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-run-slot-'));
  const workspace = await mkdtemp(join(tmpdir(), 'gate-run-slot-work-'));
  const store = new CliEnvironmentStore(gateHome);
  await store.put(validEnvironment({
    id: ENVIRONMENT_ID,
    adapterId: 'codex',
    executable: { path: join(gateHome, 'codex.exe') },
    workspacePolicy: {
      roots: [workspace],
      defaultRoot: workspace,
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns },
  }));

  const spawned = [];
  const adapter = {
    operations: { status: { risk: 'read' } },
    probe: probe ?? (async () => ({ state: 'ready', version: '9.9.9' })),
    runInvocation() {
      return { args: ['status'] };
    },
  };
  const service = new CliEnvironmentService({
    store,
    registry: { get: () => adapter },
    jobFactory: () => ({
      children: [],
      add(child) {
        this.children.push(child);
      },
      async terminate() {
        for (const child of this.children) child.kill();
      },
    }),
    spawnImpl: () => {
      const child = fakeChild();
      spawned.push(child);
      return child;
    },
  });
  return {
    service,
    spawned,
    cleanup: async () => {
      await rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function request(overrides = {}) {
  return {
    environmentId: ENVIRONMENT_ID,
    operation: 'status',
    sandbox: 'read_only',
    input: {},
    ...overrides,
  };
}

test('two concurrent starts cannot both take a single run slot', async () => {
  // Hold both starts at the probe, the await after the old limit check, so
  // each has passed the check before either registers its run.
  const probeGate = deferred();
  const { service, spawned, cleanup } = await makeService({
    probe: async () => {
      await probeGate.promise;
      return { state: 'ready', version: '9.9.9' };
    },
  });
  try {
    const first = service.startRun(request());
    const second = service.startRun(request());
    // The first start parks at the (still unresolved) probe; the second must
    // be refused from its own post-require check, before either registers.
    let secondSettled = false;
    const secondResult = second.then(
      (value) => {
        secondSettled = true;
        return { value };
      },
      (error) => {
        secondSettled = true;
        return { error };
      },
    );
    for (let waited = 0; waited < 2000 && !secondSettled; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondSettled, true, 'the second start is refused without waiting for the first probe');
    probeGate.resolve();

    const accepted = await first;
    const refused = await secondResult;
    assert.ok(refused.error, 'the other start is refused, not silently run');
    assert.equal(refused.error.code, 'busy');
    assert.match(
      refused.error.message,
      /another task is starting/,
      'the refusal names the start that holds the slot before any run id exists',
    );
    assert.equal(spawned.length, 1, 'only the accepted start reaches a spawn');
    assert.equal(service.liveRunCount(), 1);
    assert.equal(service.activeRuns(ENVIRONMENT_ID).length, 1);

    // The winner finishing really frees the slot: the reservation went with
    // it and the next start is not refused as a second holder.
    spawned[0].emit('close', 0);
    await accepted.completed;
    assert.equal(service.liveRunCount(), 0);

    const next = await service.startRun(request());
    assert.equal(typeof next.runId, 'string');
    assert.equal(service.liveRunCount(), 1);
    await service.cancel(next.runId);
  } finally {
    await cleanup();
  }
});

test('a start that fails before registering releases its reservation', async () => {
  // The first probe reports a broken CLI, so that start throws after its
  // reservation and before any run exists. If the ticket leaked, the next
  // start would be refused `busy` for a slot nobody holds.
  let probes = 0;
  const { service, spawned, cleanup } = await makeService({
    probe: async () => {
      probes += 1;
      return probes === 1
        ? { state: 'not_installed', message: 'the CLI is gone' }
        : { state: 'ready', version: '9.9.9' };
    },
  });
  try {
    await assert.rejects(
      service.startRun(request()),
      (error) => {
        assert.equal(error.code, 'not_installed');
        return true;
      },
    );
    assert.equal(service.liveRunCount(), 0, 'the failed start registered nothing');

    const handle = await service.startRun(request());
    assert.equal(service.liveRunCount(), 1, 'the slot is still free after the failure');
    // The spawn happens in the consent microtask behind startRun; wait for it
    // rather than assuming it has already run.
    for (let waited = 0; waited < 2000 && spawned.length === 0; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(spawned.length, 1, 'the run really started after the failed attempt');
    await service.cancel(handle.runId);
  } finally {
    await cleanup();
  }
});

test('a reused caller-supplied run id is refused without taking a slot', async () => {
  // Limit 2 keeps the busy check out of the way so this exercises the id
  // refusal itself: a duplicate must not register a second run, and must not
  // eat the slot its reservation took.
  const { service, cleanup } = await makeService({ maxConcurrentRuns: 2 });
  try {
    const handle = await service.startRun(request({ runId: 'run-fixed' }));
    assert.equal(handle.runId, 'run-fixed');
    assert.equal(service.liveRunCount(), 1);

    await assert.rejects(
      service.startRun(request({ runId: 'run-fixed' })),
      (error) => {
        assert.equal(error.code, 'run_id_conflict');
        return true;
      },
    );
    assert.equal(service.liveRunCount(), 1, 'the refused duplicate registered no second run');

    // The other slot is genuinely free: a distinct id still starts.
    const other = await service.startRun(request({ runId: 'run-other' }));
    assert.equal(other.runId, 'run-other');
    assert.equal(service.liveRunCount(), 2);

    await service.cancel(handle.runId);
    await service.cancel(other.runId);
    assert.equal(service.liveRunCount(), 0);
  } finally {
    await cleanup();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { widgetSnapshot } from '../core/push-notifier.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

const serverSource = fileURLToPath(new URL('../core/server.mjs', import.meta.url));
const ENVIRONMENT_ID = 'codex-local';

/**
 * A stub adapter and a fake child: what matters here is what the supervisor
 * records about the environment, not the CLI, so nothing is spawned and each
 * run lives or ends on request.
 */
const stubAdapter = {
  operations: { status: { risk: 'read' } },
  async probe() {
    return { state: 'ready', version: '9.9.9' };
  },
  runInvocation() {
    return { args: ['status'] };
  },
};

/** A CLI that can go missing under a live run: the break is a real finding. */
function toggleAdapter() {
  const control = { available: true };
  return {
    control,
    adapter: {
      ...stubAdapter,
      async probe() {
        return control.available
          ? { state: 'ready', version: '9.9.9' }
          : { state: 'not_installed', message: 'the CLI is gone' };
      },
    },
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

async function makeService({ adapter = stubAdapter, maxConcurrentRuns = 8 } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-busy-probe-'));
  const store = new CliEnvironmentStore(gateHome);
  const workspace = await mkdtemp(join(tmpdir(), 'gate-busy-probe-work-'));
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
    store,
    gateHome,
    workspace,
    spawned,
    cleanup: async () => {
      await rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function startLiveRun(service, input = {}) {
  const handle = await service.startRun({
    environmentId: ENVIRONMENT_ID,
    operation: 'status',
    sandbox: 'read_only',
    input,
  });
  return handle;
}

test('a probe mid-run keeps the environment busy, and the run\u2019s own settle decides otherwise', async () => {
  const { service, spawned, cleanup } = await makeService();
  try {
    const live = await startLiveRun(service);
    assert.equal(service.environmentState.get(ENVIRONMENT_ID).state, 'busy');

    // The phone probes an environment on every backend activation and on
    // `/env <name>`; the probe knows the CLI is there, and knows nothing about
    // the run holding the slot.
    const checked = await service.check(ENVIRONMENT_ID);
    assert.equal(checked.state, 'ready', 'the probe itself still reports what it found');
    assert.equal(service.environmentState.get(ENVIRONMENT_ID).state, 'busy', 'the probe must not erase the live run');
    assert.equal(service.environmentState.get(ENVIRONMENT_ID).probe.version, '9.9.9', 'the probed version still travels');

    await service.start(ENVIRONMENT_ID);
    assert.equal(service.environmentState.get(ENVIRONMENT_ID).state, 'busy', 'start() probes too');

    spawned[0].emit('close', 0);
    await live.completed;
    assert.equal(service.environmentState.get(ENVIRONMENT_ID).state, 'ready');
  } finally {
    await cleanup();
  }
});

test('a probe with no run in flight still writes what it found', async () => {
  const { service, cleanup } = await makeService();
  try {
    const checked = await service.check(ENVIRONMENT_ID);
    assert.equal(checked.state, 'ready');
    assert.equal(service.environmentState.get(ENVIRONMENT_ID).state, 'ready');
    assert.equal(service.environmentState.get(ENVIRONMENT_ID).probe.version, '9.9.9');
  } finally {
    await cleanup();
  }
});

test('a probe that finds a broken CLI still names the break to a phone mid-run', async () => {
  const { adapter, control } = toggleAdapter();
  const { service, spawned, cleanup } = await makeService({ adapter });
  try {
    const live = await startLiveRun(service);
    control.available = false;

    await service.check(ENVIRONMENT_ID);

    const entry = service.environmentState.get(ENVIRONMENT_ID);
    assert.equal(entry.state, 'not_installed', 'the break is a fact about the environment, not about the run');
    assert.equal(entry.probe.message, 'the CLI is gone');

    spawned[0].emit('close', 0);
    await live.completed;
  } finally {
    await cleanup();
  }
});

test('three runs on one environment are three runs in flight, not one environment', async () => {
  const { service, spawned, cleanup } = await makeService();
  try {
    const runs = [];
    for (let index = 0; index < 3; index += 1) runs.push(await startLiveRun(service, { index }));

    assert.equal(service.liveRunCount(), 3);
    assert.equal(widgetSnapshot({ busyRuns: service.liveRunCount() }).work, '3 runs in flight');

    // The count drops as runs finish, never below the ones still holding.
    spawned[0].emit('close', 0);
    await runs[0].completed;
    assert.equal(service.liveRunCount(), 2);
    assert.equal(widgetSnapshot({ busyRuns: service.liveRunCount() }).work, '2 runs in flight');

    spawned[1].emit('close', 0);
    await runs[1].completed;
    spawned[2].emit('close', 0);
    await runs[2].completed;
    assert.equal(service.liveRunCount(), 0);
    assert.equal(widgetSnapshot({ busyRuns: service.liveRunCount() }).work, 'No runs in flight');
  } finally {
    await cleanup();
  }
});

test('one run on each of two environments reads as two runs', async () => {
  const { service, store, gateHome, workspace, cleanup } = await makeService();
  try {
    await store.put(validEnvironment({
      id: 'claude-local',
      adapterId: 'codex',
      executable: { path: join(gateHome, 'codex.exe') },
      workspacePolicy: {
        roots: [workspace],
        defaultRoot: workspace,
        defaultSandbox: 'read_only',
        allowAdditionalRoots: false,
      },
      lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    }));

    await startLiveRun(service, { index: 1 });
    await service.startRun({ environmentId: 'claude-local', operation: 'status', sandbox: 'read_only', input: {} });

    assert.equal(service.liveRunCount(), 2);
    assert.equal(widgetSnapshot({ busyRuns: service.liveRunCount() }).work, '2 runs in flight');
  } finally {
    await cleanup();
  }
});

test('no live run reads as no runs in flight', async () => {
  const { service, cleanup } = await makeService();
  try {
    assert.equal(service.liveRunCount(), 0);
    assert.equal(widgetSnapshot({ busyRuns: service.liveRunCount() }).work, 'No runs in flight');
  } finally {
    await cleanup();
  }
});

test('the pushed work line counts the live runs, not the busy environments', async () => {
  // Wiring guard: the provider the Gate hands the notifier is the only place a
  // busy-environment count could creep back in, and it is a closure over the
  // environment service, so this is what pins it.
  const source = await readFile(serverSource, 'utf8');
  assert.match(source, /liveRunCount\(\)/, 'the widget snapshot provider must count live runs');
  assert.doesNotMatch(source, /state === 'busy'\)\.length/, 'the widget snapshot provider must not count busy environments');
});
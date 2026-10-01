import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { createEventLog } from '../core/cli-environments/run-protocol.mjs';
import { createRunArchive } from '../core/cli-environments/run-archive.mjs';
import {
  issueInvocationToken,
  verifyInvocationToken,
} from '../core/cli-environments/invocation-tokens.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

const ENVIRONMENT_ID = 'codex-local';

/**
 * A stub adapter and a fake child: what matters here is what the supervisor
 * keeps in memory and what it hands the child, not the CLI, so nothing is
 * spawned and each run completes (or hangs, on request) on demand.
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

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

async function makeService({
  archiveDir = null,
  maxRetainedRuns,
  defaultEndpoints = null,
} = {}, recordOverrides = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-run-retention-'));
  const store = new CliEnvironmentStore(gateHome);
  await store.put(validEnvironment({
    id: ENVIRONMENT_ID,
    adapterId: 'codex',
    executable: { path: join(gateHome, 'codex.exe') },
    credentialBindings: { OPENAI_API_KEY: 'vault-key-1' },
    workspacePolicy: {
      roots: [gateHome],
      defaultRoot: gateHome,
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 8 },
    ...recordOverrides,
  }));
  const spawned = [];
  // `hold` leaves a spawned child alive, which is how a test keeps a run in
  // flight while other runs finish around it.
  const control = { hold: false };
  const service = new CliEnvironmentService({
    store,
    registry: { get: () => stubAdapter },
    vault: { get: async () => 'sk-live-provider-key' },
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
      const child = fakeChild();
      spawned.push({ child, options });
      if (!control.hold) setTimeout(() => child.emit('close', 0), 0);
      return child;
    },
    archiveDir,
    maxRetainedRuns,
    defaultEndpoints,
  });
  return {
    service,
    spawned,
    control,
    cleanup: async () => {
      await rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (archiveDir) await rm(archiveDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function startRun(service, input = {}) {
  return service.startRun({
    environmentId: ENVIRONMENT_ID,
    operation: 'status',
    sandbox: 'read_only',
    input,
  });
}

async function drain(service, runId) {
  const events = [];
  for await (const event of service.events(runId)) events.push(event);
  return events;
}

test('finished runs are retained to a bound, and a finished run drops its secrets and handles', async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), 'gate-run-retention-archive-'));
  const { service, spawned, control, cleanup } = await makeService({ archiveDir, maxRetainedRuns: 3 });
  try {
    await service.init();
    // One run that never finishes. It holds the slot, so every later run has to
    // be seen as finished before it can be evicted.
    control.hold = true;
    const live = await startRun(service);
    while (spawned.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    control.hold = false;

    const finished = [];
    for (let index = 0; index < 33; index += 1) {
      const handle = await startRun(service, { index });
      await handle.completed;
      finished.push(handle.runId);
    }

    assert.equal(service.runs.size, 4, 'three finished runs plus the one still running');
    assert.ok(service.runs.has(live.runId), 'a run that has not finished is never evicted');
    const liveRun = service.runs.get(live.runId);
    assert.ok(liveRun.childEnv?.OPENAI_API_KEY, 'a live run still owns what it needs');
    assert.ok(liveRun.child, 'a live run still knows its child');
    assert.ok(liveRun.job, 'a live run still owns its job handle');

    for (const runId of finished.slice(-3)) {
      assert.ok(service.runs.has(runId), `the newest runs are kept: ${runId}`);
    }
    assert.equal(service.runs.has(finished[0]), false, 'the oldest finished runs are evicted');

    for (const runId of finished.slice(-3)) {
      const run = service.runs.get(runId);
      assert.equal(run.childEnv, null, 'the decrypted provider keys are released on the verdict');
      assert.equal(run.child, null, 'the child handle is released on the verdict');
      assert.equal(run.job, null, 'the job handle is released on the verdict');
    }
    assert.equal(
      spawned[1].options.env.OPENAI_API_KEY,
      'sk-live-provider-key',
      'the key really was in the child environment before the verdict',
    );

    const listed = service.listRuns(ENVIRONMENT_ID);
    assert.equal(listed.length, 4);
    assert.equal(listed[0].runId, finished.at(-1), 'the list is still newest first');
    assert.deepEqual(listed.slice(0, 3).map((run) => run.runId), finished.slice(-3).reverse());
    assert.ok(listed.every((run) => run.pid === null || run.runId === live.runId), 'a finished run advertises no pid');
  } finally {
    await cleanup();
  }
});

test('an evicted run still replays from the archive', async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), 'gate-run-evicted-archive-'));
  const { service, cleanup } = await makeService({ archiveDir, maxRetainedRuns: 1 });
  try {
    await service.init();
    const first = await startRun(service, { which: 1 });
    await first.completed;
    const second = await startRun(service, { which: 2 });
    await second.completed;

    assert.equal(service.runs.has(first.runId), false, 'the first run aged out of memory');
    assert.ok(service.runs.has(second.runId));

    const replay = await drain(service, first.runId);
    assert.equal(replay[0].type, 'run.started');
    assert.equal(replay.at(-1).type, 'run.completed');
    assert.equal(replay.at(-1).payload.exitCode, 0, 'the verdict replayed is the one that was recorded');
    assert.throws(() => service.events('run-never-issued'), /unknown run/);
  } finally {
    await cleanup();
  }
});

test('without an archive, an evicted run is unknown, exactly as an unissued id is', async () => {
  const { service, cleanup } = await makeService({ maxRetainedRuns: 1 });
  try {
    const first = await startRun(service, { which: 1 });
    await first.completed;
    const second = await startRun(service, { which: 2 });
    await second.completed;

    assert.equal(service.runs.has(first.runId), false);
    assert.throws(() => service.events(first.runId), /unknown run/);
    assert.throws(() => service.events('run-never-issued'), /unknown run/);
  } finally {
    await cleanup();
  }
});

test('the runs list and the archive prune agree on which run is newest', async () => {
  // Five runs whose ids sort the opposite way round from their start times:
  // the archive used to prune by that file-name order, the supervisor ordered
  // the survivors by clock, and the two disagreed about what "recent" meant.
  const archiveDir = await mkdtemp(join(tmpdir(), 'gate-run-order-archive-'));
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const { service, cleanup } = await makeService({ archiveDir });
  try {
    const archive = createRunArchive(archiveDir, { maxRunsPerEnvironment: 2 });
    for (const [index, runId] of ['run-0', 'run-1', 'run-2', 'run-3', 'run-4'].entries()) {
      const startedAt = new Date(base - index * 10_000).toISOString();
      archive.record({
        runId,
        environmentId: ENVIRONMENT_ID,
        operation: 'status',
        startedAt,
      });
      archive.append(ENVIRONMENT_ID, runId, {
        runId, sequence: 1, timestamp: startedAt, type: 'run.started', payload: {},
      });
      archive.append(ENVIRONMENT_ID, runId, {
        runId, sequence: 2, timestamp: startedAt, type: 'run.completed', payload: { exitCode: 0 },
      });
    }
    const restored = await archive.load();
    assert.deepEqual(
      restored.map((entry) => entry.meta.runId),
      ['run-1', 'run-0'],
      'the archive kept the two newest by clock',
    );

    await service.init();
    const listed = service.listRuns(ENVIRONMENT_ID);
    assert.deepEqual(
      listed.map((run) => run.runId),
      ['run-0', 'run-1'],
      'the supervisor orders what survived newest first, by the same key',
    );
    assert.ok(listed[0].startedAt > listed[1].startedAt);
    assert.equal(listed[0].state, 'completed');
  } finally {
    await cleanup();
  }
});

test('one run retains a bounded event window but the archive still sees every event', async () => {
  const seen = [];
  const log = createEventLog('run-chatty', { onEmit: (event) => seen.push(event) });
  log.emit({ type: 'run.started', payload: {} });
  for (let index = 0; index < 6000; index += 1) {
    log.emit({ type: 'run.output', payload: { stream: 'stdout', text: `chunk ${index}` } });
  }
  log.emit({ type: 'run.completed', payload: { exitCode: 0 } });

  const retained = log.events();
  assert.equal(retained.length, 5000, 'a single run cannot grow its log without bound');
  assert.equal(retained[0].type, 'run.started', 'the first event is never dropped');
  assert.equal(retained.at(-1).type, 'run.completed', 'nor is the verdict');
  const sequences = retained.map((event) => event.sequence);
  assert.ok(
    sequences.every((value, index) => index === 0 || value > sequences[index - 1]),
    'the retained window is still strictly increasing — a replay knows it is missing the middle',
  );
  assert.equal(sequences.at(-1), 6002, 'the newest event is the one that was emitted last');
  assert.equal(seen.length, 6002, 'the on-disk archive was handed every event, trimmed or not');

  const replay = [];
  for await (const event of log.stream()) replay.push(event);
  assert.equal(replay.length, 5000);
  assert.equal(replay[0].type, 'run.started');
  assert.equal(replay.at(-1).type, 'run.completed');
});

test('a subscriber that is caught up loses nothing when the log is trimmed', async () => {
  const log = createEventLog('run-live-subscriber');
  log.emit({ type: 'run.started', payload: {} });
  const subscriber = log.stream();
  const received = [];
  const first = await subscriber.next();
  received.push(first.value);

  // Emit and drain one at a time: the subscriber is never behind, so the cap
  // trimming the oldest events underneath it must not shift its position.
  for (let index = 0; index < 6000; index += 1) {
    log.emit({ type: 'run.output', payload: { stream: 'stdout', text: `chunk ${index}` } });
    const next = await subscriber.next();
    received.push(next.value);
  }
  log.emit({ type: 'run.completed', payload: { exitCode: 0 } });
  const terminal = await subscriber.next();
  received.push(terminal.value);

  const sequences = received.map((event) => event.sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1), 'every event arrived exactly once, in order');
  assert.equal(received[0].type, 'run.started');
  assert.equal(received.at(-1).type, 'run.completed');
  assert.ok(log.events().length <= 5000);
});

test('a run with no endpoints of its own is told the Gate port, or nothing at all', async () => {
  const previous = process.env.VERSUTUS_GATE_PORT;
  try {
    {
      process.env.VERSUTUS_GATE_PORT = '9123';
      const { service, spawned, cleanup } = await makeService();
      try {
        const handle = await startRun(service);
        await handle.completed;
        assert.equal(
          spawned[0].options.env.VERSUTUS_GATE_CHAT,
          'http://127.0.0.1:9123/v1/chat/completions',
          'the endpoint names the port the Gate is actually listening on',
        );
      } finally {
        await cleanup();
      }
    }

    {
      delete process.env.VERSUTUS_GATE_PORT;
      const { service, spawned, cleanup } = await makeService({
        defaultEndpoints: { chat: 'http://127.0.0.1:5555/v1/chat/completions' },
      });
      try {
        const handle = await startRun(service);
        await handle.completed;
        assert.equal(
          spawned[0].options.env.VERSUTUS_GATE_CHAT,
          'http://127.0.0.1:5555/v1/chat/completions',
          'a caller that knows the bound port can name it',
        );
      } finally {
        await cleanup();
      }
    }

    {
      delete process.env.VERSUTUS_GATE_PORT;
      const { service, spawned, cleanup } = await makeService();
      try {
        const handle = await startRun(service);
        await handle.completed;
        const env = spawned[0].options.env;
        assert.equal('VERSUTUS_GATE_CHAT' in env, false, 'no port 80 URL is invented for a run that has none');
        assert.ok(env.VERSUTUS_CLI_INVOCATION_TOKEN, 'the invocation token is still issued');
      } finally {
        await cleanup();
      }
    }

    {
      process.env.VERSUTUS_GATE_PORT = 'not-a-port';
      const { service, spawned, cleanup } = await makeService();
      try {
        const handle = await startRun(service);
        await handle.completed;
        assert.equal(
          'VERSUTUS_GATE_CHAT' in spawned[0].options.env,
          false,
          'an unusable port is not a port',
        );
      } finally {
        await cleanup();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.VERSUTUS_GATE_PORT;
    else process.env.VERSUTUS_GATE_PORT = previous;
  }
});

test('the invocation token replay set stays bounded', () => {
  const request = {
    environmentId: ENVIRONMENT_ID,
    runId: 'run-token',
    providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
    audience: 'versutus-gate',
    endpoints: { chat: 'http://127.0.0.1:9123/v1/chat/completions' },
  };
  const now = 1_000_000_000;
  // Far enough in the future that nothing can expire on its own: whatever is
  // forgotten here was forgotten by the cap.
  const ttlMs = 10 ** 12;
  const issued = [];
  for (let index = 0; index < 10_050; index += 1) {
    const { token } = issueInvocationToken(request, { now, ttlMs });
    issued.push(token);
    assert.equal(
      verifyInvocationToken(token, { runId: 'run-token', now }).ok,
      true,
      'a fresh token verifies',
    );
  }
  assert.equal(
    verifyInvocationToken(issued[0], { runId: 'run-token', now }).ok,
    true,
    'the oldest nonce is no longer remembered once the set is full',
  );
  assert.equal(
    verifyInvocationToken(issued.at(-1), { runId: 'run-token', now }).ok,
    false,
    'the newest nonce is still rejected as a replay',
  );
});

test('a replay inside the window is rejected, and an expired token still fails closed', () => {
  const request = {
    environmentId: ENVIRONMENT_ID,
    runId: 'run-replay',
    providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
    audience: 'versutus-gate',
    endpoints: { chat: 'http://127.0.0.1:9123/v1/chat/completions' },
  };
  const { token } = issueInvocationToken(request, { now: 5_000, ttlMs: 60_000 });
  assert.equal(verifyInvocationToken(token, { runId: 'run-replay', now: 5_001 }).ok, true);
  const replay = verifyInvocationToken(token, { runId: 'run-replay', now: 5_002 });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'replay');

  // Well past the expiry: pruning spent nonces must not turn a token that can
  // no longer be valid into one that is.
  const expired = verifyInvocationToken(token, { runId: 'run-replay', now: 70_000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'expired');
});
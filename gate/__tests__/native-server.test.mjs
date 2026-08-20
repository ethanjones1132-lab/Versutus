import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createNativeServer } from '../core/cli-environments/native-server.mjs';

const adapter = {
  adapterId: 'opencode',
  server: {
    defaultPort: 4096,
    healthPath: '/session',
    args: (port) => ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    portFromOutput: (line) => /listening on https?:\/\/[^:]+:(\d+)/.exec(line)?.[1],
  },
};

const record = {
  id: 'opencode-local',
  adapterId: 'opencode',
  executable: { path: 'C:\\opencode.exe' },
  lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300 },
  workspacePolicy: { defaultRoot: 'C:\\Projects\\Versutus' },
};

/** A child process that announces a port, as `opencode serve` does. */
function fakeChild({ port = 4599, announce = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  if (announce) {
    setTimeout(() => child.stdout.emit('data', `opencode server listening on http://127.0.0.1:${port}\n`), 5);
  }
  return child;
}

function reachable(urls) {
  return async (url) => {
    const ok = urls.some((u) => String(url).startsWith(u));
    if (!ok) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, async json() { return []; } };
  };
}

test('attaches to a server that is already listening instead of spawning', async () => {
  let spawned = 0;
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: () => { spawned += 1; return fakeChild(); },
    fetchImpl: reachable(['http://127.0.0.1:4096']),
  });

  const handle = await server.ensureRunning();
  assert.equal(handle.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(handle.attached, true, 'should report that it attached');
  assert.equal(spawned, 0, 'must not spawn when a server already answers');
});

test('stopping never kills a server it merely attached to', async () => {
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: () => fakeChild(),
    fetchImpl: reachable(['http://127.0.0.1:4096']),
  });
  await server.ensureRunning();
  await server.stop();
  // Nothing to assert beyond "did not throw and did not spawn"; the guarantee is
  // that a user's long-running server survives Gate shutdown.
  assert.equal(server.isOwned(), false);
});

test('spawns when nothing answers, and learns the port from stdout', async () => {
  let spawnArgs = null;
  const listening = new Set();
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: (command, args) => { spawnArgs = { command, args }; setTimeout(() => listening.add('http://127.0.0.1:4599'), 6); return fakeChild({ port: 4599 }); },
    fetchImpl: async (url) => {
      if ([...listening].some((u) => String(url).startsWith(u))) return { ok: true, status: 200, async json() { return []; } };
      throw new Error('ECONNREFUSED');
    },
  });

  const handle = await server.ensureRunning();
  assert.equal(handle.baseUrl, 'http://127.0.0.1:4599');
  assert.equal(handle.attached, false);
  assert.equal(server.isOwned(), true);
  assert.ok(spawnArgs.args.includes('serve'), 'should pass the adapter server args');
});

test('a spawned server is registered with the job so cancel kills the tree', async () => {
  const added = [];
  const server = createNativeServer({
    record,
    adapter,
    job: { add: (child) => added.push(child), terminate: async () => {} },
    spawnImpl: () => fakeChild({ port: 4599 }),
    fetchImpl: async (url) => {
      if (String(url).includes('4599')) return { ok: true, status: 200, async json() { return []; } };
      throw new Error('ECONNREFUSED');
    },
  });
  await server.ensureRunning();
  assert.equal(added.length, 1, 'the spawned child must be registered for tree termination');
});

test('stopping a server it spawned terminates the child', async () => {
  const child = fakeChild({ port: 4599 });
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: () => child,
    fetchImpl: async (url) => {
      if (String(url).includes('4599')) return { ok: true, status: 200, async json() { return []; } };
      throw new Error('ECONNREFUSED');
    },
  });
  await server.ensureRunning();
  await server.stop();
  assert.equal(child.killed, true);
  assert.equal(server.isOwned(), false);
});

test('ensureRunning is idempotent and does not spawn twice', async () => {
  let spawned = 0;
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: () => { spawned += 1; return fakeChild({ port: 4599 }); },
    fetchImpl: async (url) => {
      if (String(url).includes('4599')) return { ok: true, status: 200, async json() { return []; } };
      throw new Error('ECONNREFUSED');
    },
  });
  const [a, b] = await Promise.all([server.ensureRunning(), server.ensureRunning()]);
  assert.equal(a.baseUrl, b.baseUrl);
  assert.equal(spawned, 1, 'concurrent callers must share one spawn');
});

test('a server that never becomes reachable fails with a usable message', async () => {
  const server = createNativeServer({
    record,
    adapter,
    startTimeoutMs: 60,
    spawnImpl: () => fakeChild({ announce: false }),
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => server.ensureRunning(), /did not become reachable|timed out/i);
});

test('an adapter with no server descriptor cannot be a backend', async () => {
  const server = createNativeServer({
    record,
    adapter: { adapterId: 'codex' },
    spawnImpl: () => fakeChild(),
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => server.ensureRunning(), /does not expose a native server/i);
});

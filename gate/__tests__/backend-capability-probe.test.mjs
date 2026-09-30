import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';
import { createNativeServer } from '../core/cli-environments/native-server.mjs';
import { createStdioServer } from '../core/cli-environments/stdio-server.mjs';

const RECORD = {
  id: 'a-local',
  label: 'A',
  adapterId: 'a',
  enabled: true,
  executable: { path: 'C:\\tools\\a.exe' },
  workspacePolicy: { defaultRoot: 'C:\\Projects' },
};

function manager({ adapter, createServer, now } = {}) {
  return createBackendManager({
    store: {
      async get(id) { return id === RECORD.id ? RECORD : null; },
      async list() { return [RECORD]; },
    },
    registry: { get: () => adapter },
    ...(createServer ? { createServer } : {}),
    ...(now ? { now } : {}),
  });
}

/** A backend whose methods are named by `names`, so a probe can read them off. */
function backendWith(names, extra = {}) {
  return { kind: 'stub', ...extra, ...Object.fromEntries(names.map((name) => [name, () => {}])) };
}

// ─── methodsOf: a capability answer that starts nothing ───────────────────

test('methodsOf reports a backend\'s methods without starting its server', async () => {
  let built = 0;
  let started = 0;
  const subject = manager({
    adapter: {
      adapterId: 'a',
      server: { defaultPort: 1 },
      createBackend() {
        built += 1;
        return backendWith(['listModels', 'listBots'], { kind: 'a', sessions: [] });
      },
    },
    createServer: () => ({
      ensureRunning: async () => { started += 1; return { baseUrl: 'http://127.0.0.1:1' }; },
      stop: async () => {},
      isOwned: () => false,
    }),
  });

  const methods = await subject.methodsOf('a-local');
  assert.ok(methods.has('listModels'));
  assert.ok(methods.has('listBots'));
  assert.ok(!methods.has('kind'), 'a value that is not a method is not a capability');
  assert.ok(!methods.has('sessions'), 'a data property is not a capability either');
  assert.equal(started, 0, 'a capability probe must not start anything');

  const again = await subject.methodsOf('a-local');
  assert.deepEqual([...again].sort(), [...methods].sort(), 'the probe is cached per environment');
  assert.equal(built, 1, 'the factory is consulted once per environment');
});

test('methodsOf answers null when the capability cannot be established', async () => {
  let started = 0;
  const createServer = () => ({
    ensureRunning: async () => { started += 1; return { baseUrl: 'http://127.0.0.1:1' }; },
    stop: async () => {},
    isOwned: () => false,
  });

  const throws = manager({
    adapter: { adapterId: 'a', server: { defaultPort: 1 }, createBackend() { throw new Error('cannot build here'); } },
    createServer,
  });
  assert.equal(await throws.methodsOf('a-local'), null, 'a factory that throws is unknown');

  const nonsense = manager({
    adapter: { adapterId: 'a', server: { defaultPort: 1 }, createBackend: () => 'not a backend' },
    createServer,
  });
  assert.equal(await nonsense.methodsOf('a-local'), null, 'a factory that returns no backend is unknown');

  assert.equal(await throws.methodsOf('no-such-environment'), null, 'an unknown environment is unknown');
  assert.equal(started, 0, 'nothing on this path may start a server');
});

test('a capability probe hands each transport an inert stand-in', async () => {
  const seen = [];
  const recording = (server) => ({
    adapterId: 'a',
    server,
    createBackend(options) { seen.push(options); return backendWith(['listBots']); },
  });

  await manager({ adapter: recording({ transport: 'per-turn' }) }).methodsOf('a-local');
  assert.deepEqual(Object.keys(seen.at(-1)), ['record'], 'a per-turn backend needs only the record');
  assert.equal(seen.at(-1).record, RECORD);

  await manager({ adapter: recording({ transport: 'stdio', args: () => ['app-server'] }) }).methodsOf('a-local');
  const stdio = seen.at(-1);
  assert.equal(stdio.cwd, 'C:\\Projects');
  assert.equal(typeof stdio.subscribe, 'function');
  assert.equal(typeof stdio.subscribe(() => {}), 'function', 'the probe never registers a listener');
  await assert.rejects(
    () => stdio.rpc.request('thread/list'),
    /no app-server/,
    'the probe rpc refuses every call',
  );

  await manager({ adapter: recording({ defaultPort: 1 }) }).methodsOf('a-local');
  const http = seen.at(-1);
  assert.equal(http.baseUrl, 'http://127.0.0.1:0', 'no reachable address, so nothing can be contacted');
  assert.deepEqual(http.credentials, {});
});

// ─── a backend that will not start is not retried per request ─────────────

test('a backend that will not start is refused once per window, not once per request', async () => {
  let clock = 0;
  let attempts = 0;
  let broken = true;
  const subject = manager({
    adapter: { adapterId: 'a', server: { defaultPort: 1 }, createBackend: () => backendWith(['listBots']) },
    now: () => clock,
    createServer: () => ({
      ensureRunning: async () => {
        attempts += 1;
        if (broken) throw new Error('a server did not become reachable within 30000ms');
        return { baseUrl: 'http://127.0.0.1:1' };
      },
      stop: async () => {},
      isOwned: () => false,
    }),
  });

  for (let request = 0; request < 5; request += 1) {
    await assert.rejects(() => subject.get('a-local'), /did not become reachable/);
  }
  assert.equal(attempts, 1, 'five requests pay for one start attempt');

  // 5s, 15s, 60s, then 300s forever after.
  for (const [window, expected] of [[5_000, 2], [20_000, 3], [80_000, 4], [380_000, 5], [680_000, 6]]) {
    clock = window;
    await assert.rejects(() => subject.get('a-local'), /did not become reachable/);
    assert.equal(attempts, expected, `a start is retried once the ${window}ms window passes`);
  }

  broken = false;
  clock = 980_000;
  const recovered = await subject.get('a-local');
  assert.equal(typeof recovered.listBots, 'function');
  assert.equal(attempts, 7, 'the recovery still cost one start attempt');

  // The ladder restarts from the first window, so a backend that has answered
  // once is not left waiting out a five-minute window.
  broken = true;
  await assert.rejects(() => subject.get('a-local'), /did not become reachable/);
  assert.equal(attempts, 8);
  clock = 985_000;
  broken = false;
  const again = await subject.get('a-local');
  assert.equal(typeof again.listBots, 'function');
  assert.equal(attempts, 9, 'a success cleared the remembered failure');
});

// ─── a stdio app-server that dies comes back ──────────────────────────────

let appServers = 0;

/** A fake `codex app-server`: answers the handshake, nothing else. */
function fakeAppServer() {
  appServers += 1;
  const child = new EventEmitter();
  child.label = `app-server-${appServers}`;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  child.stdin = new EventEmitter();
  child.stdin.write = (line) => {
    const request = JSON.parse(line);
    setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`));
  };
  return child;
}

const CODEX_SERVER = {
  transport: 'stdio',
  args: () => ['app-server'],
  handshake: { method: 'initialize', params: {} },
};

function stdioManager() {
  const spawned = [];
  const subject = manager({
    adapter: { adapterId: 'codex', server: CODEX_SERVER, createBackend: ({ rpc }) => ({ rpc }) },
    createServer: ({ record, adapter, onNotification }) => createStdioServer({
      record,
      adapter,
      onNotification,
      spawnImpl: () => { const child = fakeAppServer(); spawned.push(child); return child; },
      job: { add() {}, terminate: async () => {} },
    }),
  });
  return { subject, spawned };
}

test('a stdio backend whose app-server dies is respawned and rebound', async () => {
  const { subject, spawned } = stdioManager();
  const first = await subject.get('a-local');
  assert.equal(spawned.length, 1);
  assert.ok(first.rpc, 'the backend is bound to the app-server rpc');

  // The CLI's app-server crashes between turns. Reusing the handle it left
  // behind fails every later Codex request with "app-server is not running"
  // until the Gate restarts.
  spawned[0].emit('exit', 1);

  const second = await subject.get('a-local');
  assert.equal(spawned.length, 2, 'a dead app-server is respawned, not reused');
  assert.notEqual(second, first, 'the cached backend must not outlive its pipe');
  assert.notEqual(second.rpc, first.rpc, 'the new backend is bound to the new rpc');

  const third = await subject.get('a-local');
  assert.equal(third, second, 'a live app-server keeps its backend');
  assert.equal(spawned.length, 2, 'and costs no respawn');
});

/** A child whose executable is missing: 'error' arrives, 'exit' never does. */
function unsplawnableChild(path) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => {};
  child.kill = () => {};
  setImmediate(() => {
    child.emit('error', Object.assign(new Error(`spawn ${path} ENOENT`), { code: 'ENOENT' }));
  });
  return child;
}

/** Uncaught exceptions during `run`, which must stay empty. */
async function withoutUncaught(run) {
  const uncaught = [];
  const record = (error) => uncaught.push(error);
  process.on('uncaughtException', record);
  try {
    return { value: await run(), uncaught };
  } finally {
    process.off('uncaughtException', record);
  }
}

test('a stdio app-server whose executable is missing refuses at once', async () => {
  const record = { ...RECORD, executable: { path: 'C:\\missing\\codex.exe' } };
  const started = Date.now();
  const { uncaught } = await withoutUncaught(() => {
    const server = createStdioServer({
      record,
      adapter: { adapterId: 'codex', server: CODEX_SERVER },
      spawnImpl: () => unsplawnableChild('C:\\missing\\codex.exe'),
      job: { add() {}, terminate: async () => {} },
    });
    return assert.rejects(() => server.ensureRunning(), (error) => {
      assert.match(error.message, /codex\.exe/, 'the refusal names the executable');
      assert.match(error.message, /ENOENT/, 'and the OS error code');
      return true;
    });
  });
  assert.deepEqual(uncaught, [], 'a missing executable must not take the Gate down');
  assert.ok(Date.now() - started < 1000, 'and must not wait out the 30s handshake');
});

test('a stdio server with no handshake still refuses an executable that cannot spawn', async () => {
  const record = { ...RECORD, executable: { path: 'C:\\missing\\codex.exe' } };
  const { uncaught } = await withoutUncaught(() => {
    const server = createStdioServer({
      record,
      adapter: { adapterId: 'codex', server: { transport: 'stdio', args: () => ['app-server'] } },
      spawnImpl: () => unsplawnableChild('C:\\missing\\codex.exe'),
      job: { add() {}, terminate: async () => {} },
    });
    return assert.rejects(() => server.ensureRunning(), /codex\.exe/);
  });
  assert.deepEqual(uncaught, [], 'a missing executable must not take the Gate down');
});

// ─── the HTTP supervisor's spawn failure ──────────────────────────────────

test('a native server whose executable is missing refuses at once, naming it', async () => {
  const adapter = {
    adapterId: 'opencode',
    server: {
      defaultPort: 4096,
      healthPath: '/session',
      args: (port) => ['serve', '--port', String(port)],
      portFromOutput: () => null,
    },
  };
  const record = { ...RECORD, executable: { path: 'C:\\missing\\opencode.exe' } };
  // The shipped ceiling is 30s; a shorter one keeps the failing case quick and
  // still proves the refusal lands long before the deadline.
  const started = Date.now();
  const { uncaught } = await withoutUncaught(() => {
    const server = createNativeServer({
      record,
      adapter,
      startTimeoutMs: 5_000,
      spawnImpl: () => unsplawnableChild('C:\\missing\\opencode.exe'),
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    return assert.rejects(() => server.ensureRunning(), (error) => {
      assert.match(error.message, /opencode\.exe/, 'the refusal names the executable');
      assert.match(error.message, /ENOENT/, 'and the OS error code');
      return true;
    });
  });
  assert.deepEqual(uncaught, [], 'a missing executable must not take the Gate down');
  assert.ok(Date.now() - started < 2_000, 'and must not poll until the start timeout');
});
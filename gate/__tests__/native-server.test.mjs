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

function serverWithBannerPassword({ credentials = {}, onDiagnostic = () => {} } = {}) {
  const password = 'generated-runtime-password';
  const passwordAdapter = {
    ...adapter,
    server: {
      ...adapter.server,
      healthPathFor: () => '/api/info',
      healthJson: true,
      detectMajor: async () => 2,
      authSchemeFor: () => 'basic',
      passwordFromOutput: (line) => /server password\s+(\S+)/i.exec(line)?.[1],
    },
  };
  const server = createNativeServer({
    record,
    adapter: passwordAdapter,
    credentials,
    onDiagnostic,
    spawnImpl: () => {
      const child = fakeChild({ announce: false });
      setTimeout(() => child.stdout.emit('data', `server password ${password}\n`), 5);
      setTimeout(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4599\n'), 10);
      return child;
    },
    fetchImpl: async (url, init = {}) => {
      if (!String(url).startsWith('http://127.0.0.1:4599')) throw new Error('ECONNREFUSED');
      const expected = credentials.OPENCODE_SERVER_PASSWORD ?? password;
      const authorization = init.headers?.Authorization;
      const expectedAuthorization = `Basic ${Buffer.from(`opencode:${expected}`).toString('base64')}`;
      if (authorization !== expectedAuthorization) {
        return { ok: false, status: 401, async text() { return ''; } };
      }
      return { ok: true, status: 200, async text() { return '{"version":"2.0.0"}'; } };
    },
  });
  return { server, password };
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

test('keeps the generated password internal while making it available to the backend', async () => {
  const diagnostics = [];
  const { server, password } = serverWithBannerPassword({
    onDiagnostic: ({ message }) => diagnostics.push(message),
  });

  const handle = await server.ensureRunning();

  assert.deepEqual(server.credentialsForBackend(), { OPENCODE_SERVER_PASSWORD: password });
  assert.equal(Object.hasOwn(handle, 'OPENCODE_SERVER_PASSWORD'), false, 'the server handle must not carry secrets');
  assert.equal(JSON.stringify(handle).includes(password), false, 'serializing the handle must not expose the secret');
  assert.equal(diagnostics.some((message) => message.includes(password)), false, 'the startup banner must stay redacted');

  const backendCredentials = server.credentialsForBackend();
  backendCredentials.OPENCODE_SERVER_PASSWORD = 'changed-by-caller';
  assert.deepEqual(server.credentialsForBackend(), { OPENCODE_SERVER_PASSWORD: password }, 'callers receive a copy');
  await server.stop();
  assert.deepEqual(server.credentialsForBackend(), {}, 'stopping clears the recovered runtime secret');
});

test('a bound password takes precedence over the generated banner password', async () => {
  const { server, password } = serverWithBannerPassword({
    credentials: { OPENCODE_SERVER_PASSWORD: 'bound-vault-password' },
  });

  await server.ensureRunning();

  assert.notEqual(password, 'bound-vault-password');
  assert.deepEqual(server.credentialsForBackend(), { OPENCODE_SERVER_PASSWORD: 'bound-vault-password' });
  await server.stop();
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

test('a healthy cached handle is reused without spawning', async () => {
  let spawned = 0;
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: () => { spawned += 1; return fakeChild(); },
    fetchImpl: reachable(['http://127.0.0.1:4096']),
  });
  const a = await server.ensureRunning();
  const b = await server.ensureRunning();
  assert.equal(a.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(b.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(spawned, 0, 'a live server must not cost a spawn per turn');
});

test('an attached server that goes away is replaced instead of failing later turns', async () => {
  let attachedAlive = true;
  let spawned = 0;
  const ok = () => ({ ok: true, status: 200, async json() { return []; } });
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: () => { spawned += 1; return fakeChild({ port: 4599 }); },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.startsWith('http://127.0.0.1:4096')) {
        if (attachedAlive) return ok();
        throw new Error('ECONNREFUSED');
      }
      if (target.startsWith('http://127.0.0.1:4599')) return ok();
      throw new Error('ECONNREFUSED');
    },
  });

  const first = await server.ensureRunning();
  assert.equal(first.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(first.attached, true);

  // The operator stops their own server between turns: the port goes quiet
  // while the environment still reports ready. The next turn must recover,
  // not hand the dead handle to the backend.
  attachedAlive = false;
  const second = await server.ensureRunning();
  assert.equal(second.baseUrl, 'http://127.0.0.1:4599');
  assert.equal(second.attached, false);
  assert.equal(spawned, 1, 'a dead attached server must fall through to a fresh spawn');
});

test('a spawned server that later dies is respawned on the next turn', async () => {
  const listening = new Set();
  let spawned = 0;
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: () => {
      spawned += 1;
      setTimeout(() => listening.add('http://127.0.0.1:4599'), 6);
      return fakeChild({ port: 4599 });
    },
    fetchImpl: async (url) => {
      if ([...listening].some((u) => String(url).startsWith(u))) {
        return { ok: true, status: 200, async json() { return []; } };
      }
      throw new Error('ECONNREFUSED');
    },
  });

  const first = await server.ensureRunning();
  assert.equal(first.baseUrl, 'http://127.0.0.1:4599');
  assert.equal(spawned, 1);

  // The child dies between turns. Reusing its handle would fail the turn
  // with a transport error; the next ensureRunning must spawn again.
  listening.delete('http://127.0.0.1:4599');
  const second = await server.ensureRunning();
  assert.equal(second.baseUrl, 'http://127.0.0.1:4599');
  assert.equal(spawned, 2, 'a dead owned server must be respawned, not reused');
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

/**
 * A server that accepts the connection and then says nothing at all: the wedged
 * `opencode serve` the health probe has to tell from a refusal.
 *
 * Models a real fetch — it settles when its own signal aborts, and holds a ref'd
 * handle until then, because `AbortSignal.timeout()` arms an unref'd timer and a
 * fetch that never arrives would otherwise leave the loop with nothing to wait
 * on.
 */
function silentFetch() {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const inFlight = setTimeout(() => {}, 5_000);
      const fail = () => {
        clearTimeout(inFlight);
        reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
      };
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener('abort', fail, { once: true });
    });
}

// A probe with no signal of its own left every request waiting for undici's own
// ~300 s headers timeout, and a refusal is indistinguishable from that wait: the
// start timeout below never engaged because nothing threw, so the Gate held the
// request open for minutes against a server that would never answer it.
test('a server that never answers the health route is refused, not waited on', async () => {
  const server = createNativeServer({
    record,
    adapter,
    startTimeoutMs: 150,
    spawnImpl: () => fakeChild({ announce: false }),
    fetchImpl: silentFetch(),
  });

  const attempt = server.ensureRunning();
  // Raced, so an unbounded probe settles the suite red in seconds instead of
  // hanging it: the defect is a request that never settles at all.
  const outcome = await Promise.race([
    attempt.then(
      () => ({ state: 'resolved' }),
      (error) => ({ state: 'rejected', message: error.message }),
    ),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ state: 'pending' }), 8_000);
      timer.unref?.();
    }),
  ]);

  assert.equal(outcome.state, 'rejected', 'a wedged server must be named, not waited out');
  assert.match(outcome.message ?? '', /did not become reachable/i);
});

test('reachable() sees a server that came up, and never starts one', async () => {
  // The manager re-probes with this inside a backoff window: a refusal remembered
  // from a start that failed is stale the moment the server is up, and there must
  // be a cheap way to find that out that costs no start attempt.
  let up = false;
  let spawned = 0;
  const server = createNativeServer({
    record,
    adapter,
    spawnImpl: () => { spawned += 1; return fakeChild(); },
    fetchImpl: async (url) => {
      if (up && String(url).startsWith('http://127.0.0.1:4096')) {
        return { ok: true, status: 200, async json() { return []; } };
      }
      throw new Error('ECONNREFUSED');
    },
  });

  assert.equal(await server.reachable(), false, 'nothing is listening yet');
  up = true;
  assert.equal(await server.reachable(), true, 'the operator\'s own server is now answering');
  assert.equal(spawned, 0, 'a re-probe must never spawn a second instance');
});

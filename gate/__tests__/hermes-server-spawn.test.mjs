import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeServer } from '../core/cli-environments/native-server.mjs';
import { hermesAdapter, hermesServerEnvironment } from '../core/cli-environments/adapters/hermes.mjs';

// Issue #1 item 1: Hermes 0.19 has no `--port`, so `hermes gateway run --port 0`
// exited 2 before it was reachable. The API server is configured by
// API_SERVER_* in the environment instead.

const record = {
  id: 'hermes-local',
  adapterId: 'hermes',
  executable: { path: '/Users/test/.hermes/hermes-agent/venv/bin/hermes' },
  workspacePolicy: { defaultRoot: '/Users/test/code' },
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.emit('exit', 0); };
  return child;
}

const noJob = () => ({ add() {}, async terminate() {}, reset() {} });

test('a spawned Hermes server gets `gateway run` and its port, host and key from the environment', async (t) => {
  // HERMES_HOME resolution reads the ambient variable; keep the host's own out.
  const ambient = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
  t.after(() => { if (ambient !== undefined) process.env.HERMES_HOME = ambient; });
  // So does the ~/.hermes fallback (os.homedir() follows HOME): on a machine
  // whose real ~/.hermes has profiles/ that home wins, as designed, over the
  // record's profile-less one. Point HOME somewhere with no Hermes at all.
  const ambientHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), 'hermes-spawn-home-'));
  t.after(async () => {
    await rm(process.env.HOME, { recursive: true, force: true });
    process.env.HOME = ambientHome;
  });
  const spawns = [];
  const up = new Set();
  const server = createNativeServer({
    record,
    adapter: hermesAdapter,
    job: noJob(),
    credentials: { API_SERVER_KEY: 'hermes-key-123' },
    buildEnvironment: async ({ credentials }) => ({ PATH: '/usr/bin', HOME: '/Users/test', ...credentials, API_SERVER_PORT: '1' }),
    spawnImpl: (command, args, options) => {
      spawns.push({ command, args, env: options.env });
      setTimeout(() => up.add('http://127.0.0.1:8642'), 5);
      return fakeChild();
    },
    fetchImpl: async (url) => {
      if ([...up].some((origin) => String(url).startsWith(origin))) return { ok: true, status: 200 };
      throw new Error('ECONNREFUSED');
    },
    startTimeoutMs: 2000,
  });

  const handle = await server.ensureRunning();
  assert.equal(handle.baseUrl, 'http://127.0.0.1:8642');
  assert.equal(handle.attached, false);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, record.executable.path);
  assert.deepEqual(spawns[0].args, ['gateway', 'run'], 'no --port: Hermes 0.19 rejects it');
  const { env } = spawns[0];
  assert.equal(env.API_SERVER_ENABLED, 'true');
  assert.equal(env.API_SERVER_PORT, '8642', 'the descriptor wins over a stray inherited value');
  assert.equal(env.API_SERVER_HOST, '127.0.0.1');
  assert.equal(env.API_SERVER_KEY, 'hermes-key-123');
  assert.equal(env.HERMES_HOME, '/Users/test/.hermes', 'pinned to the home the backend reads profiles from');
  assert.equal(env.PATH, '/usr/bin', 'the built child environment is kept');
  await server.stop();
});

test('a record baseUrl port is where a spawned Hermes listens and is polled', async () => {
  const spawns = [];
  const up = new Set();
  const server = createNativeServer({
    record: { ...record, server: { baseUrl: 'http://127.0.0.1:8650/' } },
    adapter: hermesAdapter,
    job: noJob(),
    credentials: { HERMES_API_SERVER_KEY: 'alias-key' },
    spawnImpl: (command, args, options) => {
      spawns.push({ args, env: options.env });
      setTimeout(() => up.add('http://127.0.0.1:8650'), 5);
      return fakeChild();
    },
    fetchImpl: async (url) => {
      if ([...up].some((origin) => String(url).startsWith(origin))) return { ok: true, status: 200 };
      throw new Error('ECONNREFUSED');
    },
    startTimeoutMs: 2000,
  });
  const handle = await server.ensureRunning();
  assert.equal(handle.baseUrl, 'http://127.0.0.1:8650');
  assert.equal(spawns[0].env.API_SERVER_PORT, '8650');
  assert.equal(spawns[0].env.API_SERVER_KEY, 'alias-key', 'the HERMES_ alias of the key is honoured');
  await server.stop();
});

test('an already-running Hermes is attached to, never spawned beside', async () => {
  let spawned = 0;
  const server = createNativeServer({
    record,
    adapter: hermesAdapter,
    job: noJob(),
    spawnImpl: () => { spawned += 1; return fakeChild(); },
    fetchImpl: async (url) => {
      if (String(url) === 'http://127.0.0.1:8642/health') return { ok: true, status: 200 };
      throw new Error('ECONNREFUSED');
    },
  });
  const handle = await server.ensureRunning();
  assert.equal(handle.attached, true);
  assert.equal(handle.baseUrl, 'http://127.0.0.1:8642');
  assert.equal(spawned, 0);
});

test('a Hermes that still exits names its exit code, as before', async () => {
  const server = createNativeServer({
    record,
    adapter: hermesAdapter,
    job: noJob(),
    spawnImpl: () => {
      const child = fakeChild();
      setTimeout(() => child.emit('exit', 2), 5);
      return child;
    },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    startTimeoutMs: 2000,
  });
  await assert.rejects(server.ensureRunning(), /hermes server exited with code 2 before becoming reachable/);
});

test('without a bound key the environment says so by leaving API_SERVER_KEY out, not empty', () => {
  const env = hermesServerEnvironment({ port: 8642, credentials: {}, record });
  assert.equal('API_SERVER_KEY' in env, false);
  assert.equal(env.API_SERVER_PORT, '8642');
  assert.equal(hermesServerEnvironment({ port: 0 }).API_SERVER_PORT, '8642');
});

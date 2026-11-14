import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { selectDefaultBackend } from '../core/backend-resolution.mjs';

// Issue #1 item 5: a request without a backendId went to the first registered
// environment. On the Mac that was Hermes, which could not start, so every
// such request failed while a ready OpenCode sat beside it.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('no environments is still the 404 it always was', async () => {
  const picked = await selectDefaultBackend({ entries: [] });
  assert.equal(picked.status, 404);
  assert.equal(picked.body.error.code, 'no_backend');
});

test('the first ready environment wins over an earlier one that is not', async () => {
  const picked = await selectDefaultBackend({
    entries: [{ id: 'hermes-local' }, { id: 'opencode-local' }],
    stateOf: (id) => ({ 'hermes-local': 'degraded', 'opencode-local': 'ready' })[id],
  });
  assert.deepEqual(picked, { id: 'opencode-local' });
});

test('a busy environment (a run in flight) is still a usable chat backend', async () => {
  const picked = await selectDefaultBackend({
    entries: [{ id: 'a' }, { id: 'b' }],
    stateOf: (id) => ({ a: 'not_installed', b: 'busy' })[id],
  });
  assert.deepEqual(picked, { id: 'b' });
});

test('unprobed environments are probed once, in order, and stop at the first ready one', async () => {
  const probed = [];
  const picked = await selectDefaultBackend({
    entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    stateOf: (id) => (id === 'a' ? 'stopped' : undefined),
    probe: async (id) => { probed.push(id); return id === 'b' ? 'ready' : 'degraded'; },
  });
  assert.deepEqual(picked, { id: 'b' });
  assert.deepEqual(probed, ['a', 'b']);
});

test('a configured default wins when usable, and steps aside when it is not', async () => {
  const states = { a: 'ready', b: 'ready', c: 'degraded' };
  assert.deepEqual(
    await selectDefaultBackend({ entries: [{ id: 'a' }, { id: 'b' }], stateOf: (id) => states[id], defaultId: 'b' }),
    { id: 'b' },
  );
  assert.deepEqual(
    await selectDefaultBackend({ entries: [{ id: 'c' }, { id: 'a' }], stateOf: (id) => states[id], defaultId: 'c' }),
    { id: 'a' },
  );
});

test('nothing ready is a 503 naming each candidate, its state and a probe failure', async () => {
  const picked = await selectDefaultBackend({
    entries: [{ id: 'hermes-local' }, { id: 'opencode-local' }],
    stateOf: (id) => (id === 'hermes-local' ? 'degraded' : undefined),
    probe: async () => { throw new Error('spawn ENOENT'); },
    defaultId: 'claude-local',
  });
  assert.equal(picked.status, 503);
  assert.equal(picked.body.error.code, 'no_ready_backend');
  assert.match(picked.body.error.message, /hermes-local: degraded/);
  assert.match(picked.body.error.message, /opencode-local: probe failed \(spawn ENOENT\)/);
  assert.match(picked.body.error.message, /configured default "claude-local" is not attached/);
  assert.match(picked.body.error.message, /Pass backendId/);
});

test('a native proof is tried only after CLI-ready backends and prefers the configured default', async () => {
  const tried = [];
  const picked = await selectDefaultBackend({
    entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    stateOf: () => 'degraded',
    defaultId: 'b',
    nativeReady: async (id) => { tried.push(id); return true; },
  });
  assert.deepEqual(picked, { id: 'b' });
  assert.deepEqual(tried, ['b']);

  tried.length = 0;
  const registrationFallback = await selectDefaultBackend({
    entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    stateOf: () => 'degraded',
    defaultId: 'b',
    nativeReady: async (id) => { tried.push(id); return id === 'a'; },
  });
  assert.deepEqual(registrationFallback, { id: 'a' });
  assert.deepEqual(tried, ['b', 'a'], 'the configured default is followed by registration order');

  tried.length = 0;
  const cliReady = await selectDefaultBackend({
    entries: [{ id: 'a' }, { id: 'b' }],
    stateOf: (id) => id === 'b' ? 'ready' : 'degraded',
    nativeReady: async (id) => { tried.push(id); return true; },
  });
  assert.deepEqual(cliReady, { id: 'b' });
  assert.deepEqual(tried, [], 'a ready CLI backend keeps precedence over native fallback');
});

test('a failed native proof preserves the original 503 state summary', async () => {
  const picked = await selectDefaultBackend({
    entries: [{ id: 'opencode-local' }],
    stateOf: () => 'degraded',
    nativeReady: async () => { throw new Error('catalogue unavailable'); },
  });
  assert.equal(picked.status, 503);
  assert.equal(picked.body.error.code, 'no_ready_backend');
  assert.match(picked.body.error.message, /opencode-local: degraded/);
});

test('a timed-out native proof stays unavailable and ignores its late failure', async () => {
  let signal;
  const picked = await selectDefaultBackend({
    entries: [{ id: 'opencode-local' }],
    stateOf: () => 'degraded',
    nativeReadyTimeoutMs: 10,
    nativeReady: (_id, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late failure')), 30));
    },
  });
  assert.equal(picked.status, 503);
  assert.match(picked.body.error.message, /opencode-local: degraded/);
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 35));
});

// ─── wired through the Gate ────────────────────────────────────────────────

function registryWith(states) {
  const adapters = Object.entries(states).map(([adapterId, state]) => ({
    adapterId,
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state, cliVersion: '1.0.0', message: state === 'ready' ? undefined : `${adapterId} is ${state}` }; },
    createBackend() {
      return {
        async listSessions() { return [{ id: `${adapterId}-session`, title: adapterId }]; },
        async sendMessage() { return { text: 'x' }; },
      };
    },
  }));
  return {
    get(id) {
      const found = adapters.find((adapter) => adapter.adapterId === id);
      if (!found) throw new Error(`unknown CLI adapter "${id}"`);
      return found;
    },
    list() { return adapters; },
  };
}

async function makeGate(states, gateOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-default-backend-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  for (const adapterId of Object.keys(states)) {
    await writeFile(join(gateHome, 'config', 'environments', `${adapterId}.json`), JSON.stringify({
      schemaVersion: 1,
      kind: 'cli-environment',
      id: adapterId,
      label: adapterId,
      adapterId,
      executable: { path: '/usr/bin/true' },
      protocolPreference: ['acp'],
      versionPolicy: { supported: '1.x', adapterRevision: '1' },
      providerRefs: [],
      workspacePolicy: { roots: [root], defaultRoot: root, defaultSandbox: 'read_only', allowAdditionalRoots: false },
      lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
      enabled: true,
    }), 'utf8');
  }
  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registryWith(states),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
    ...gateOptions,
  });
  return gate;
}

async function getSessions(gate, query = '') {
  const response = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions${query}`, {
    headers: { Authorization: `Bearer ${gate.token}` },
  });
  return { status: response.status, body: await response.json() };
}

test('a request without backendId is served by the ready environment, not the first one', async () => {
  // Environments list in id order: a-hermes sorts first and is degraded.
  const gate = await makeGate({ 'a-hermes': 'degraded', 'b-opencode': 'ready' });
  try {
    const { status, body } = await getSessions(gate);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(JSON.stringify(body).includes('b-opencode-session'), true);
    // An explicit pin is still honoured, ready or not.
    const pinned = await getSessions(gate, '?backendId=a-hermes');
    assert.equal(JSON.stringify(pinned.body).includes('a-hermes-session'), true);
  } finally {
    await gate.close();
  }
});

test('the configured default backend answers when it is ready', async () => {
  const gate = await makeGate({ 'a-claude': 'ready', 'b-opencode': 'ready' }, { defaultBackendId: 'b-opencode' });
  try {
    const { body } = await getSessions(gate);
    assert.equal(JSON.stringify(body).includes('b-opencode-session'), true);
  } finally {
    await gate.close();
  }
});

test('with nothing ready the Gate answers 503 no_ready_backend instead of failing on the first', async () => {
  const gate = await makeGate({ 'a-hermes': 'degraded', 'b-opencode': 'not_installed' });
  try {
    const { status, body } = await getSessions(gate);
    assert.equal(status, 503);
    assert.equal(body.error.code, 'no_ready_backend');
    assert.match(body.error.message, /a-hermes: degraded, b-opencode: not_installed/);
  } finally {
    await gate.close();
  }
});

test('default routing accepts a working OpenCode native catalogue without rewriting CLI state', async () => {
  let probeCalls = 0;
  let modelReads = 0;
  let sessionReads = 0;
  const opencode = {
    adapterId: 'opencode',
    adapterRevision: '2',
    supportedCliVersions: '2.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'models'],
    server: { transport: 'http' },
    async probe() {
      probeCalls += 1;
      return { state: 'degraded', cliVersion: '2.2.6', message: 'cli probe timed out' };
    },
    createBackend() {
      return {
        async listModels() {
          modelReads += 1;
          return [{ id: 'deepseek/free', providerId: 'deepseek', modelId: 'free' }];
        },
        async listSessions() {
          sessionReads += 1;
          return [{ id: 'opencode-session', title: 'OpenCode' }];
        },
      };
    },
  };
  const registry = {
    get(id) {
      if (id !== 'opencode') throw new Error(`unknown adapter ${id}`);
      return opencode;
    },
    list() { return [opencode]; },
  };
  const gate = await makeGate({ opencode: 'degraded' }, {
    environmentRegistry: registry,
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:4096', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
  try {
    const listed = await getSessions(gate);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data[0].id, 'opencode-session');
    assert.equal(probeCalls, 1);
    assert.equal(modelReads, 1, 'only a real model catalogue array proves the native backend');
    assert.equal(sessionReads, 1, 'the selected backend serves the actual read-only route');

    const backendsResponse = await fetch(`http://127.0.0.1:${gate.port}/v1/backends`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    const { backends } = await backendsResponse.json();
    assert.equal(backends.find((backend) => backend.id === 'opencode').state, 'degraded', 'native success does not rewrite CLI status');

    const explicitlyPinned = await getSessions(gate, '?backendId=opencode');
    assert.equal(explicitlyPinned.status, 200);
    assert.equal(modelReads, 1, 'an explicit backend scope bypasses default readiness selection');
  } finally {
    await gate.close();
  }
});

// ─── bind address (design spec: 127.0.0.1 behind Tailscale Serve) ──────────

function firstExternalIpv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (!addr.internal && (addr.family === 'IPv4' || addr.family === 4)) return addr.address;
    }
  }
  return null;
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

test('the Gate listens on loopback by default, and on another address only when told', async (t) => {
  const gate = await makeGate({ 'a-opencode': 'ready' });
  try {
    assert.equal(gate.host, '127.0.0.1');
    assert.equal(await canConnect('127.0.0.1', gate.port), true);
    const external = firstExternalIpv4();
    if (!external) {
      t.diagnostic('no non-loopback IPv4 on this host; the refusal half is not observable here');
    } else {
      assert.equal(await canConnect(external, gate.port), false, `must not accept on ${external}`);
    }
  } finally {
    await gate.close();
  }

  const open = await makeGate({ 'a-opencode': 'ready' }, { host: '0.0.0.0' });
  try {
    assert.equal(open.host, '0.0.0.0');
    const external = firstExternalIpv4();
    if (external) assert.equal(await canConnect(external, open.port), true);
  } finally {
    await open.close();
  }
});

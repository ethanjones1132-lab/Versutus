import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { createBackendRunStreams } from '../core/cli-environments/backend-run-streams.mjs';

/**
 * Hermes-kind run events used to die at the Gate: Hermes buffers a run's
 * events only while it is live, so replaying a finished run 404'd upstream
 * and the Gate answered 500 — breaking "a finished task stays provable".
 * The Gate now tees the live stream into <gateHome>/run-streams and answers
 * replays from disk, and an upstream refusal is a real status, never a 500.
 */

const FRAMES = [
  'data: {"type":"run.started","sequence":1}\n\n',
  'data: {"type":"message.delta","sequence":2,"data":{"text":"hello"}}\n\n',
  'data: {"type":"run.completed","sequence":3,"data":{"exit_code":0}}\n\n',
];

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function streamBody(frames, delayMs = 2) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= frames.length) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(Buffer.from(frames[index]));
      index += 1;
    },
  });
}

/** The common route surface a stub backend must carry. */
function plainBackend() {
  return {
    async listSessions() { return []; },
    async createSession() { return {}; },
    async deleteSession() {},
    async listMessages() { return []; },
    async sendMessage() { return { text: '', message: null }; },
    async listModels() { return []; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
  };
}

/**
 * A Hermes-shaped backend whose runEvents behavior is switchable mid-test:
 * `state.mode` 'stream' emits FRAMES; 'gone' throws an upstream 404 (the
 * live-only buffer is gone); 'err' throws the given status.
 */
function runsBackend(state, calls = []) {
  return {
    ...plainBackend(),
    async startRun() { return { id: 'run_1', object: 'run' }; },
    async getRunStatus() { return { id: 'run_1', status: 'completed', exit_code: 0 }; },
    async steerRun() {},
    async stopRun() {},
    async runEvents(runId) {
      calls.push(`runEvents:${runId}`);
      if (state.mode === 'stream') {
        return { ok: true, status: 200, body: streamBody(FRAMES) };
      }
      const error = new Error(state.message ?? `hermes: run events HTTP ${state.status}`);
      if (state.status !== undefined) error.status = state.status;
      throw error;
    },
  };
}

function registryFor(state, calls) {
  const backend = runsBackend(state, calls);
  const make = (adapterId, capabilities) => ({
    adapterId,
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities,
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend: () => backend,
  });
  return {
    get(id) {
      if (id !== 'hermescli') throw new Error(`unknown CLI adapter "${id}"`);
      return make('hermescli', ['sessions', 'tools', 'models', 'runs']);
    },
    list() { return [make('hermescli', ['sessions', 'tools', 'models', 'runs'])]; },
  };
}

async function environmentFile(gateHome, id) {
  await writeFile(join(gateHome, 'config', 'environments', `${id}.json`), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id, label: id,
    adapterId: 'hermescli', executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');
}

async function makeGate({ mode = 'stream', gateHomeOverride } = {}) {
  const calls = [];
  const state = {
    mode,
    ...(mode === 'gone'
      ? { status: 404, message: 'hermes: run events HTTP 404 (run finished; live buffer dropped)' }
      : {}),
  };
  const root = await mkdtemp(join(tmpdir(), 'gate-runstreams-'));
  roots.push(root);
  const gateHome = gateHomeOverride ?? join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  if (!gateHomeOverride) await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await environmentFile(gateHome, 'hermescli');

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registryFor(state, calls),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
  return { gate, state, calls, gateHome };
}

const auth = (gate) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` });
const base = (gate) => `http://127.0.0.1:${gate.port}`;

test('a live relay streams the frames and archives them for later replay', async () => {
  const { gate, state } = await makeGate();
  try {
    const first = await fetch(`${base(gate)}/v1/runs/run_1/events`, { headers: auth(gate) });
    assert.equal(first.status, 200);
    assert.equal(await first.text(), FRAMES.join(''));

    // The run finished: Hermes dropped its live-only buffer and now 404s.
    // The Gate must still answer the replay from its own archive.
    state.mode = 'gone';
    const again = await fetch(`${base(gate)}/v1/runs/run_1/events`, { headers: auth(gate) });
    assert.equal(again.status, 200);
    assert.equal(await again.text(), FRAMES.join(''), 'replay must reproduce the exact relayed bytes');
  } finally {
    await gate.close();
  }
});

test('a finished run replays from disk after a Gate restart, with Hermes gone', async () => {
  const { gate, gateHome } = await makeGate();
  await fetch(`${base(gate)}/v1/runs/run_1/events`, { headers: auth(gate) });
  await gate.close();

  // A fresh Gate over the same gateHome (the promise the runbook makes) with
  // the upstream now refusing: replay must still answer from the archive.
  const second = await makeGate({ mode: 'gone', gateHomeOverride: gateHome });
  try {
    const response = await fetch(`${base(second.gate)}/v1/runs/run_1/events`, { headers: auth(second.gate) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), FRAMES.join(''));
  } finally {
    await second.gate.close();
  }
});

test('an upstream 404 on a never-archived run is an honest 404, not a 500', async () => {
  const { gate } = await makeGate({ mode: 'gone' });
  try {
    const response = await fetch(`${base(gate)}/v1/runs/run_never/events`, { headers: auth(gate) });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'run_events_unavailable');
    assert.match(body.error.message, /404/);
  } finally {
    await gate.close();
  }
});

test('upstream 5xx and unknown failures map to real statuses, never an invented 500 shape', async () => {
  const { gate, state } = await makeGate({ mode: 'err' });
  try {
    state.status = 502;
    const refused = await fetch(`${base(gate)}/v1/runs/run_x/events`, { headers: auth(gate) });
    assert.equal(refused.status, 502);
    assert.equal((await refused.json()).error.code, 'upstream_error');

    state.mode = 'boom';
    const broken = await fetch(`${base(gate)}/v1/runs/run_x/events`, { headers: auth(gate) });
    assert.equal(broken.status, 502, 'a throw without a status is a 502, matching every other route');
  } finally {
    await gate.close();
  }
});

test('concurrent live relays each stream, but only one copy reaches the archive', async () => {
  const { gate, gateHome } = await makeGate();
  try {
    const [a, b] = await Promise.all([
      fetch(`${base(gate)}/v1/runs/run_1/events`, { headers: auth(gate) }),
      fetch(`${base(gate)}/v1/runs/run_1/events`, { headers: auth(gate) }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await a.text(), FRAMES.join(''));
    assert.equal(await b.text(), FRAMES.join(''));

    const archived = await readFile(join(gateHome, 'run-streams', 'run_1.sse'), 'utf8');
    assert.equal(archived, FRAMES.join(''), 'the tee must be single-writer: no duplicated frames');
  } finally {
    await gate.close();
  }
});

test('archive paths are sanitized: an encoded traversal run id stays inside the store', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'gate-runstreams-unit-')), 'streams');
  roots.push(dir);
  const store = createBackendRunStreams(dir, { maxRuns: 50 });
  assert.equal(store.begin('..%2F..%2Fevil'), true);
  store.append('..%2F..%2Fevil', Buffer.from(FRAMES[0]));
  store.end('..%2F..%2Fevil');

  const names = await readdir(dir);
  assert.deepEqual(names, ['.._2F.._2Fevil.sse'], 'segment separators must be flattened, never honored');
  assert.equal((await store.read('..%2F..%2Fevil')).toString(), FRAMES[0]);
  assert.equal(await store.read('does-not-exist'), null);
});

test('the store ignores appends without a tee claim and bounds run count and size', async () => {
  // Prune needs the byte cap out of the way: capped chunks never reach the
  // append counter that triggers the prune walk.
  const dir = join(await mkdtemp(join(tmpdir(), 'gate-runstreams-unit-')), 'streams');
  roots.push(dir);
  const store = createBackendRunStreams(dir, { maxRuns: 2 });

  store.append('rogue', Buffer.from(FRAMES[0]));
  assert.equal(await store.read('rogue'), null, 'no live claim means no archive write');

  assert.equal(store.begin('run_a'), true);
  for (let i = 0; i < 6; i += 1) store.append('run_a', Buffer.from('aaaaaa'));
  store.end('run_a');
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(store.begin('run_b'), true);
  for (let i = 0; i < 6; i += 1) store.append('run_b', Buffer.from('bbbbbb'));
  store.end('run_b');
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(store.begin('run_c'), true);
  for (let i = 0; i < 6; i += 1) store.append('run_c', Buffer.from('cccccc'));
  store.end('run_c');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(await store.read('run_a'), null, 'oldest run beyond maxRuns is pruned');
  assert.ok((await store.read('run_b')).length > 0);
  assert.ok((await store.read('run_c')).length > 0);

  const capped = join(await mkdtemp(join(tmpdir(), 'gate-runstreams-unit-')), 'streams');
  roots.push(capped);
  const tiny = createBackendRunStreams(capped, { maxRuns: 3, maxBytesPerRun: 10 });
  assert.equal(tiny.begin('big'), true);
  tiny.append('big', Buffer.from('0123456789ABCDEF'));
  tiny.end('big');
  assert.equal((await tiny.read('big')).length, 10, 'a runaway stream is bounded, never unbounded');
});
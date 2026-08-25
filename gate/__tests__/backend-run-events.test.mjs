import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import { utimesSync } from 'node:fs';
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
  // Trigger the prune walk with no tee active: an actively-teed run is never
  // pruned from under its relay, so the bound must be provable with the tee
  // released (run_a is the oldest seeded file and must be the one removed).
  assert.equal(store.begin('run_d'), true);
  for (let i = 0; i < 17; i += 1) store.append('run_d', Buffer.from('dddddd'));
  store.end('run_d');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(await store.read('run_a'), null, 'oldest run beyond maxRuns is pruned');
  assert.ok((await store.read('run_b')).length > 0);
  assert.ok((await store.read('run_c')).length > 0);
  assert.ok((await store.read('run_d')).length > 0);

  const capped = join(await mkdtemp(join(tmpdir(), 'gate-runstreams-unit-')), 'streams');
  roots.push(capped);
  const tiny = createBackendRunStreams(capped, { maxRuns: 3, maxBytesPerRun: 10 });
  assert.equal(tiny.begin('big'), true);
  tiny.append('big', Buffer.from('0123456789ABCDEF'));
  tiny.end('big');
  assert.equal((await tiny.read('big')).length, 10, 'a runaway stream is bounded, never unbounded');
});

test('a capped stream never earns its completeness marker', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'gate-runstreams-unit-')), 'streams');
  roots.push(dir);
  const store = createBackendRunStreams(dir, { maxRuns: 3, maxBytesPerRun: 10 });
  assert.equal(store.begin('big'), true);
  store.append('big', Buffer.from('0123456789ABCDEF'));
  // The relay reached the end, but the file holds only a truncated prefix:
  // markComplete must refuse to bless it as the whole story.
  store.markComplete('big');
  store.end('big');
  assert.equal(store.isComplete('big'), false, 'a truncated prefix must never read as a complete verdict');
  assert.equal((await store.read('big')).length, 10, 'the byte bound still holds');
});

test('begin() starts a fresh file over a partial from an older process', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'gate-runstreams-unit-')), 'streams');
  roots.push(dir);
  await mkdir(dir, { recursive: true });
  // An older process relayed the first two frames and died mid-run: partial
  // bytes on disk, no completeness marker.
  await writeFile(join(dir, 'run_r.sse'), FRAMES[0] + FRAMES[1]);

  const store = createBackendRunStreams(dir, { maxRuns: 50 });
  assert.equal(store.begin('run_r'), true);
  // The live upstream re-streams from the run's first event, so re-teeing
  // into the same file would double every earlier frame.
  store.append('run_r', Buffer.from(FRAMES.join('')));
  store.markComplete('run_r');
  store.end('run_r');

  assert.equal(await readFile(join(dir, 'run_r.sse'), 'utf8'), FRAMES.join(''), 'stale partial frames must not be duplicated into the healed archive');
  assert.equal(store.isComplete('run_r'), true);

  // A marked (complete) file is complete history: a later begin() never
  // resets it, and the marker survives.
  assert.equal(store.begin('run_r'), true);
  store.append('run_r', Buffer.from('TAIL'));
  store.end('run_r');
  assert.equal(await readFile(join(dir, 'run_r.sse'), 'utf8'), FRAMES.join('') + 'TAIL');
  assert.equal(store.isComplete('run_r'), true);
});

test('prune protects an active tee and buries the marker with its stream', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'gate-runstreams-unit-')), 'streams');
  roots.push(dir);
  const store = createBackendRunStreams(dir, { maxRuns: 2 });

  // Seed three finished runs with forced mtimes so pruning has a definitive
  // oldest target (run_d, the only seeded complete one) to remove.
  for (const [id, mtime] of [['run_d', 1000], ['run_a', 2000], ['run_b', 3000]]) {
    assert.equal(store.begin(id), true);
    store.append(id, Buffer.from(FRAMES[0]));
    store.markComplete(id);
    store.end(id);
    utimesSync(join(dir, `${id}.sse`), new Date(mtime), new Date(mtime));
    utimesSync(join(dir, `${id}.complete`), new Date(mtime), new Date(mtime));
  }

  // run_c becomes the active tee carrying a STALE mtime from an older process
  // (the restart race): backdated past every peer, an unguarded prune would
  // pick it as the oldest and delete it mid-tee.
  assert.equal(store.begin('run_c'), true);
  store.append('run_c', Buffer.from(FRAMES[0]));
  utimesSync(join(dir, 'run_c.sse'), new Date(500), new Date(500));
  assert.equal(store.isActive('run_c'), true);

  // Cross the prune trigger (every 16 appends) with appends from ANOTHER run:
  // the trigger must fire while run_c's file is still stale and untouched.
  assert.equal(store.begin('run_f'), true);
  for (let i = 0; i < 13; i += 1) store.append('run_f', Buffer.from('f'));
  store.markComplete('run_f');
  store.end('run_f');
  store.markComplete('run_c');
  store.end('run_c');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const names = await readdir(dir);
  assert.ok(names.includes('run_c.sse'), 'the active tee must never be pruned from under the relay');
  assert.ok(names.includes('run_c.complete'));
  assert.ok(!names.includes('run_d.sse'), 'the oldest seeded run is the one removed instead');
  assert.ok(!names.includes('run_d.complete'), 'pruning a run buries its completeness marker too');
  assert.ok(names.includes('run_a.sse') && names.includes('run_b.sse'), 'the rest of the window survives');
});

test('a partial archive without its marker re-streams live and heals, never serving stale frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-runstreams-reseed-'));
  roots.push(root);
  const gateHome = join(root, 'home');
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await mkdir(join(gateHome, 'run-streams'), { recursive: true });
  // An older Gate process relayed the first two frames and died mid-run:
  // partial bytes on disk, no completeness marker. The run is still live
  // upstream, which re-streams from its first event.
  await writeFile(join(gateHome, 'run-streams', 'run_1.sse'), FRAMES[0] + FRAMES[1]);

  const { gate, calls } = await makeGate({ gateHomeOverride: gateHome });
  try {
    const response = await fetch(`${base(gate)}/v1/runs/run_1/events`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), FRAMES.join(''), 'the live upstream must re-stream the full run, never the stale partial');
    assert.ok(calls.includes('runEvents:run_1'), 'an unmarked archive must proxy, not trust the snapshot');

    const archived = await readFile(join(gateHome, 'run-streams', 'run_1.sse'), 'utf8');
    assert.equal(archived, FRAMES.join(''), 'the healed archive must hold exactly one copy of the stream');
    const names = await readdir(join(gateHome, 'run-streams'));
    assert.ok(names.includes('run_1.complete'), 'reaching the clean end of the stream earns the completeness marker');
  } finally {
    await gate.close();
  }
});

test('a partial archive is served flagged, never silent, when the upstream refuses to re-stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-runstreams-partial-'));
  roots.push(root);
  const gateHome = join(root, 'home');
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await mkdir(join(gateHome, 'run-streams'), { recursive: true });
  await writeFile(join(gateHome, 'run-streams', 'run_1.sse'), FRAMES[0] + FRAMES[1]);

  const { gate } = await makeGate({ mode: 'gone', gateHomeOverride: gateHome });
  try {
    const response = await fetch(`${base(gate)}/v1/runs/run_1/events`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-run-archive-incomplete'), 'true', 'a partial fallback must be explicitly flagged');
    assert.equal(await response.text(), FRAMES[0] + FRAMES[1], 'the captured frames are the best evidence left');
  } finally {
    await gate.close();
  }
});

test('a marked archive is the whole story: replay never touches the upstream again', async () => {
  const first = await makeGate();
  await fetch(`${base(first.gate)}/v1/runs/run_1/events`, { headers: auth(first.gate) });
  await first.gate.close();

  // The upstream is live again and would happily re-stream, but a marked
  // archive must answer from disk: replaying a finished run is not a new
  // relay and must not depend on Hermes being up.
  const second = await makeGate({ gateHomeOverride: first.gateHome });
  try {
    const names = await readdir(join(first.gateHome, 'run-streams'));
    assert.ok(names.includes('run_1.complete'), 'the first relay earned its marker');
    const response = await fetch(`${base(second.gate)}/v1/runs/run_1/events`, { headers: auth(second.gate) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), FRAMES.join(''));
    assert.deepEqual(second.calls, [], 'a complete archive is served from disk without an upstream call');
  } finally {
    await second.gate.close();
  }
});
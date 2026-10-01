import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { KEEPALIVE_MS, sseHeaders, startSseKeepalive } from '../core/sse.mjs';

// A phone on a mobile network cannot tell a quiet stream from a dead one: the
// NAT may have dropped the mapping while the socket looked fine, and a
// backgrounded app never gets an error at all. So every stream the Gate writes
// says how often it will prove it is alive (`X-Versutus-Keepalive-Ms`) and
// proves it (`: keepalive`).

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A response stand-in with just the surface startSseKeepalive touches. */
class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.writableEnded = false;
    this.destroyed = false;
  }

  write(chunk) {
    if (this.writableEnded || this.destroyed) throw new Error('write after end');
    this.writes.push(chunk);
    return true;
  }

  end() {
    this.writableEnded = true;
    this.emit('finish');
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('sseHeaders carries the streaming contract and the heartbeat cadence', () => {
  assert.deepEqual(sseHeaders(), {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Versutus-Keepalive-Ms': String(KEEPALIVE_MS),
  });
  // A route's own headers must survive the shared ones.
  assert.equal(sseHeaders({ 'X-Versutus-Session-Id': 'ses_1' })['X-Versutus-Session-Id'], 'ses_1');
  assert.equal(KEEPALIVE_MS, 15000);
});

test('a silent response is written comment frames, and nothing once it ends', async () => {
  const res = new FakeRes();
  const stop = startSseKeepalive(res, { intervalMs: 5 });
  await wait(40);
  assert.ok(res.writes.length >= 2, `expected repeated keepalives, got ${res.writes.length}`);
  assert.deepEqual([...new Set(res.writes)], [': keepalive\n\n']);

  res.end();
  const written = res.writes.length;
  await wait(30);
  assert.equal(res.writes.length, written, 'a finished response gets no further frame');

  // stop() is what a route calls when it ends early; calling it twice is safe.
  stop();
  stop();
  await wait(20);
  assert.equal(res.writes.length, written);
});

test('a destroyed response stops the heartbeat instead of throwing into a timer', async () => {
  const res = new FakeRes();
  startSseKeepalive(res, { intervalMs: 5 });
  res.destroyed = true;
  await wait(30);
  assert.deepEqual(res.writes, [], 'nothing may be written to a dead socket');
});

// ─── The four streaming routes, on a real Gate ─────────────────────────

const SESSION = { id: 'ses_1', source: 'stubcli', user_id: null, model: null, title: 'Stub', started_at: 1, ended_at: null, end_reason: null, message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, api_call_count: 0, parent_session_id: null, last_active: 1, preview: null, has_system_prompt: false, has_model_config: false };

/** A backend whose turn and run streams both stay open and say nothing. */
function silentRegistry() {
  const adapter = {
    adapterId: 'stubcli',
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models', 'runs'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend() {
      const never = () => new Promise(() => {});
      return {
        async listSessions() { return [SESSION]; },
        async createSession(input) { return { ...SESSION, title: input?.title ?? null }; },
        async deleteSession() {},
        async listMessages() { return []; },
        sendMessage: never,
        async listModels() { return []; },
        async startRun() { return { run_id: 'run_1', status: 'running' }; },
        async getRunStatus() { return { status: 'running' }; },
        async stopRun() {},
        async replyApproval() {},
        async abort() {},
        streamEvents(id, onEvent, signal) {
          return new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', resolve, { once: true });
          });
        },
        runEvents() {
          return new Response(new ReadableStream({ start() { /* open, and quiet */ } }), {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        },
      };
    },
  };
  return {
    get(id) { if (id !== 'stubcli') throw new Error(`unknown CLI adapter "${id}"`); return adapter; },
    list() { return [adapter]; },
  };
}

/** A terminal manager whose shell is silent until the test says otherwise. */
function fakeTerminal() {
  const opened = [];
  return {
    opened,
    open(handlers) {
      const session = {
        sid: `sid-${opened.length + 1}`,
        owner: handlers.owner ?? null,
        write() {},
        close() {},
        handlers,
      };
      opened.push(session);
      return session;
    },
    get(sid) { return opened.find((session) => session.sid === sid) ?? null; },
    closeAll() {},
  };
}

/** A registry whose run stream replays `steps`, waiting `gapMs` before each. */
function scriptedRunEvents(steps, gapMs) {
  const registry = silentRegistry();
  const adapter = registry.get('stubcli');
  const createBackend = adapter.createBackend.bind(adapter);
  adapter.createBackend = () => {
    const backend = createBackend();
    backend.runEvents = () => new Response(new ReadableStream({
      async start(controller) {
        for (const text of steps) {
          await wait(gapMs);
          controller.enqueue(new TextEncoder().encode(text));
        }
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    return backend;
  };
  return registry;
}

async function makeGate({ registry = silentRegistry(), terminalSessions = fakeTerminal() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-keepalive-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'stub-local.json'), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id: 'stub-local', label: 'Stub',
    adapterId: 'stubcli', executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registry,
    terminalSessions,
    // A heartbeat a client can actually see inside a test.
    keepaliveIntervalMs: 10,
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {}, isOwned: () => false,
    }),
  });
  return gate;
}

const auth = (gate) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` });

/** Read raw bytes until the first `: keepalive` frame or the deadline. */
async function firstKeepalive(response, ms = 2000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  let seen = '';
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      if (seen.includes(': keepalive\n\n')) return { ok: true, text: seen };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { ok: false, text: seen };
}

for (const [label, open] of [
  ['a chat turn', async (gate) => fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
    method: 'POST', headers: auth(gate),
    body: JSON.stringify({ backendId: 'stub-local', sessionId: 'ses_1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })],
  ['a run event relay', async (gate) => {
    const started = await fetch(`http://127.0.0.1:${gate.port}/v1/runs`, {
      method: 'POST', headers: auth(gate), body: JSON.stringify({ input: 'quiet run' }),
    });
    const { run_id: runId } = await started.json();
    return fetch(`http://127.0.0.1:${gate.port}/v1/runs/${encodeURIComponent(runId)}/events`, { headers: auth(gate) });
  }],
  ['the terminal', async (gate) => fetch(`http://127.0.0.1:${gate.port}/v1/terminal/stream`, { headers: auth(gate) })],
]) {
  test(`${label} announces its cadence and heartbeats while it is silent`, async () => {
    const gate = await makeGate();
    try {
      const response = await open(gate);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-versutus-keepalive-ms'), '15000');
      const { ok, text } = await firstKeepalive(response);
      assert.ok(ok, `no keepalive frame arrived (read ${JSON.stringify(text)})`);
    } finally {
      await gate.close();
    }
  });
}

test('the heartbeat is a comment, so a client reading only data frames is unaffected', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/terminal/stream`, { headers: auth(gate) });
    const { text } = await firstKeepalive(response);
    // The terminal's own frame is `event: session`; the heartbeat carries no
    // event name and no data, which is exactly how a client skips it.
    const dataLines = text.split('\n').filter((line) => line.startsWith('data: '));
    assert.deepEqual(dataLines, [`data: ${JSON.stringify({ sid: 'sid-1' })}`]);
  } finally {
    await gate.close();
  }
});

test('a run replayed from the archive does not advertise a heartbeat it never sends', async () => {
  // Hermes buffers a run's events only while it is live, so a phone reopening a
  // finished run is answered from the Gate's own archive: the whole history in
  // one write, and the response is over. Advertising a 15-second cadence there
  // is a promise the route does not keep, and a client told to wait for a
  // heartbeat that cannot arrive is told the stream is dead.
  const steps = ['data: {"type":"run.started"}\n\n', 'data: {"type":"run.completed"}\n\n'];
  const gate = await makeGate({ registry: scriptedRunEvents(steps, 0) });
  try {
    const started = await fetch(`http://127.0.0.1:${gate.port}/v1/runs`, {
      method: 'POST', headers: auth(gate), body: JSON.stringify({ input: 'replayed run' }),
    });
    const { run_id: runId } = await started.json();

    const live = await fetch(`http://127.0.0.1:${gate.port}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: auth(gate),
    });
    assert.equal(live.headers.get('x-versutus-keepalive-ms'), '15000');
    assert.match(await live.text(), /run\.completed/);

    // The relay reached the stream's clean end, so the archive is marked
    // complete and the second request is served from it.
    const replay = await fetch(`http://127.0.0.1:${gate.port}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: auth(gate),
    });
    assert.equal(replay.status, 200);
    assert.equal(
      replay.headers.get('x-versutus-keepalive-ms'),
      null,
      'a response that is already complete must not promise a heartbeat',
    );
    // A heartbeat is the Gate's own frame and is never archived as history, so
    // the replay is the upstream stream exactly as it arrived.
    assert.equal(await replay.text(), steps.join(''));
  } finally {
    await gate.close();
  }
});

test('a relayed run stream is relayed byte for byte, heartbeats only at frame boundaries', async () => {
  // The relay writes upstream bytes exactly as they arrive, so most chunks end
  // mid-line. A keepalive written into one of those would terminate the
  // half-written line and hand the client a truncated event — which both app
  // parsers drop in silence, losing the run's output with no error anywhere.
  const steps = [
    'data: {"type":"run.started"}\n\n',
    // Split mid-line, and split again inside a multi-byte character, with a
    // silence long enough for several heartbeats to want to fire.
    'data: {"type":"run.output","payload":{"text":"half a — very ',
    'long line"}}\n\n',
    'data: [DONE]\n\n',
  ];
  const upstream = steps.join('');
  const gate = await makeGate({ registry: scriptedRunEvents(steps, 60) });
  try {
    const started = await fetch(`http://127.0.0.1:${gate.port}/v1/runs`, {
      method: 'POST', headers: auth(gate), body: JSON.stringify({ input: 'split run' }),
    });
    const { run_id: runId } = await started.json();
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: auth(gate),
    });
    assert.equal(response.status, 200);
    const relayed = Buffer.from(await response.arrayBuffer());
    const upstreamBody = Buffer.from(upstream, 'utf8');

    // Every byte offset at which a heartbeat may legally appear: the start of
    // the stream, and just past every blank line the upstream wrote.
    const boundaries = new Set([0]);
    for (const [blank, width] of [['\n\n', 2], ['\r\n\r\n', 4]]) {
      for (let at = upstreamBody.indexOf(blank); at !== -1; at = upstreamBody.indexOf(blank, at + 1)) {
        boundaries.add(at + width);
      }
    }

    const frame = Buffer.from(': keepalive\n\n', 'utf8');
    const upstreamBytes = [];
    let cursor = 0;
    let heartbeats = 0;
    for (;;) {
      const at = relayed.indexOf(frame, cursor);
      if (at === -1) {
        upstreamBytes.push(relayed.subarray(cursor));
        break;
      }
      // Each heartbeat inserted exactly `frame.length` bytes, so the upstream
      // offset of the next one is its own offset less all of them.
      const consumed = at - heartbeats * frame.length;
      assert.ok(
        boundaries.has(consumed),
        `a keepalive was injected at byte ${consumed}, which is not an SSE frame boundary`,
      );
      upstreamBytes.push(relayed.subarray(cursor, at));
      heartbeats += 1;
      cursor = at + frame.length;
    }
    assert.ok(heartbeats >= 1, 'a quiet relay must still prove it is alive');
    assert.deepEqual(Buffer.concat(upstreamBytes), upstreamBody, 'the relay must not alter a single upstream byte');
  } finally {
    await gate.close();
  }
});


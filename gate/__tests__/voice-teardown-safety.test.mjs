// Teardown safety: an audit sink that cannot make its directory, a model
// download that never answers, and a re-attach that supersedes a live socket.
// Every case is hermetic: the audit uses a temp dir, the install uses fake
// `runUv`/`fetch`, and the media test uses an ephemeral loopback listener with
// a fake engine — no child process, no external network, no real credential.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket } from 'ws';

import { createVoiceAudit } from '../core/voice/audit.mjs';
import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';
import { fetchVerified, installVoice, voicePaths } from '../core/voice/runtime.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'voice-teardown-'));
}

// ─── The audit line must not take teardown down with it ──────────────────

test('a failed audit directory reads as skipped, not a thrown teardown', () => {
  const root = tempDir();
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'not a directory');
  const audit = createVoiceAudit({
    dir: join(blocked, 'voice'),
    now: () => '2026-11-02T00:00:00.000Z',
  });

  // `mkdirSync` throws ENOTDIR here. The reducer calls the sink from `end()`,
  // so throwing would stop the terminal frames and leave the call half-closed.
  let result;
  assert.doesNotThrow(() => {
    result = audit.record({ deviceId: 'dev-1', engine: 'local', turns: 1 });
  });
  assert.equal(result, false, 'an unwritable audit line reports that nothing was written');

  // Taking the obstacle away lets the next call write: a failed attempt must
  // not leave the sink permanently "ready".
  unlinkSync(blocked);
  assert.equal(audit.record({ deviceId: 'dev-1', engine: 'local', error: 'network' }), true);
  const lines = readFileSync(join(blocked, 'voice', 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'only the line that could be written is on disk');
  assert.equal(JSON.parse(lines[0]).error, 'network');
});

// ─── A download that never answers must not hang the install ─────────────

test('a download that never answers is refused at its deadline', async () => {
  const dir = tempDir();
  const dest = join(dir, 'model.bin');
  const started = Date.now();
  await assert.rejects(
    fetchVerified({
      url: 'https://example/model.bin',
      dest,
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 50,
    }),
    (error) => {
      assert.equal(error.code, 'download_timeout');
      assert.match(error.message, /timed out/);
      assert.match(error.message, /model\.bin/, 'the failure names the download');
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, 'the deadline is what ends the wait');
  assert.equal(existsSync(dest), false);
});

test('install refuses a stalled model download instead of waiting forever', async () => {
  const dir = tempDir();
  const paths = voicePaths({ VERSUTUS_GATE_HOME: dir }, 'linux');
  const lock = {
    models: { 'core.onnx': { url: 'https://example/core' } },
  };

  await assert.rejects(
    installVoice({
      paths,
      runUv: async () => {},
      fetch: () => new Promise(() => {}),
      lock,
      downloadTimeoutMs: 50,
      log: () => {},
    }),
    (error) => error.code === 'download_timeout',
  );
});

// ─── A re-attach must close the socket it supersedes ─────────────────────

class FakeEngine extends EventEmitter {
  constructor() {
    super();
    this.id = 'local';
    this.closed = false;
  }

  async open() {}

  pushAudio() {}

  speak() {}

  cancelSpeech() {}

  setMuted() {}

  async close() {
    this.closed = true;
  }
}

const SESSION = {
  voiceSessionId: 'vs-1',
  deviceId: 'dev-1',
  engine: 'local',
  thread: { kind: 'bot', sessionId: 'sess-1', botId: 'scout' },
};

async function startMedia(engine, { supersededGraceMs } = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create(SESSION);
  const deviceTokens = {
    verify: async (authorization) => (
      String(authorization) === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null
    ),
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => engine,
    runTurn: async () => ({ hasContent: true }),
    utteranceHoldMs: 0,
    supersededGraceMs,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    registry,
    clientCount: () => wss.clients.size,
    endAll: (reason) => wss.endAll(reason),
    close: () => new Promise((done) => wss.close(() => server.close(done))),
  };
}

function connect(port) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=vs-1`,
    { headers: { Authorization: 'Bearer tok-1' } },
  );
  const frames = [];
  ws.on('message', (data) => {
    frames.push(JSON.parse(data.toString()));
  });
  return { ws, frames };
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 10));
  }
}

test('a re-attach frees a superseded socket that cannot answer', async () => {
  // The half-open phone on Tailscale: the old connection is still open on the
  // Gate but its peer will never read another byte. Pausing the client stands
  // in for that dead link — it cannot answer the probe.
  const engine = new FakeEngine();
  const media = await startMedia(engine, { supersededGraceMs: 40 });
  const first = connect(media.port);
  let second = null;
  try {
    await once(first.ws, 'open');
    await waitUntil(() => first.frames.some((frame) => frame.t === 'ready'));
    first.ws.pause();

    second = connect(media.port);
    await once(second.ws, 'open');
    await waitUntil(() => second.frames.some((frame) => frame.t === 'ready'));

    // The call moved to the new socket; the old one is dead, so the bound
    // frees it instead of holding it for the life of the Gate.
    await waitUntil(() => media.clientCount() === 1, 2000);
    assert.equal(media.clientCount(), 1, 'the dead socket was freed');
    assert.equal(second.ws.readyState, WebSocket.OPEN, 'the new socket serves the call');
    assert.equal(engine.closed, false, 'the call is still alive');
    assert.equal(media.registry.get('vs-1').ended, false);
  } finally {
    second?.ws.close();
    first.ws.resume();
    first.ws.terminate();
    media.endAll('test-done');
    await media.close();
  }
});

test('a re-attach leaves a live old socket to the phone that owns it', async () => {
  // A phone that still answers is a live connection, not a leak: it closes its
  // own old socket, which is today's re-attach behaviour.
  const engine = new FakeEngine();
  const media = await startMedia(engine, { supersededGraceMs: 40 });
  const first = connect(media.port);
  let second = null;
  try {
    await once(first.ws, 'open');
    await waitUntil(() => first.frames.some((frame) => frame.t === 'ready'));

    second = connect(media.port);
    await once(second.ws, 'open');
    await waitUntil(() => second.frames.some((frame) => frame.t === 'ready'));

    await new Promise((done) => setTimeout(done, 150));
    assert.equal(first.ws.readyState, WebSocket.OPEN, 'an answering socket is not terminated');
    assert.equal(media.clientCount(), 2);
    assert.equal(second.ws.readyState, WebSocket.OPEN);
    assert.equal(media.registry.get('vs-1').ended, false);

    const closed = once(first.ws, 'close');
    first.ws.close();
    await closed;
    assert.equal(engine.closed, false, 'the old socket closing does not end the call');
  } finally {
    second?.ws.close();
    first.ws.terminate();
    media.endAll('test-done');
    await media.close();
  }
});

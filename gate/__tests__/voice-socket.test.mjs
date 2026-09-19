import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry, createVoiceRpc } from '../core/voice/voice-rpc.mjs';
import { ScriptedEngine } from '../core/voice/engines/scripted-engine.mjs';

const TOKENS = { 'tok-1': { deviceId: 'dev-1' }, 'tok-2': { deviceId: 'dev-2' } };
const SESSION = { voiceSessionId: 'vs-1', deviceId: 'dev-1', engine: 'local' };
const BOOTSTRAP_SESSION = { voiceSessionId: 'vs-boot', deviceId: 'bootstrap:phone-abc123', engine: 'local' };
// The Gate's own token: a phone connected with it has no device grant.
const BOOTSTRAP_TOKENS = { verify: async (authorization) => authorization === 'Bearer gate-own-token' };

async function startMedia({ noAudioTimeoutMs = 30_000, tokenStore = null } = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create(SESSION);
  registry.create(BOOTSTRAP_SESSION);
  const deviceTokens = {
    verify: async (authorization) => {
      const [scheme, token] = String(authorization ?? '').split(' ');
      if (scheme !== 'Bearer' || !token) return null;
      return TOKENS[token] ?? null;
    },
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    tokenStore,
    registry,
    createEngine: () => new ScriptedEngine({ text: 'from engine', framesBeforeFinal: 1 }),
    noAudioTimeoutMs,
  });
  server.listen(0);
  await once(server, 'listening');
  return {
    port: server.address().port,
    registry,
    close: () =>
      new Promise((done) => {
        wss.close(() => server.close(done));
      }),
  };
}

function urlFor(port, sessionId = 'vs-1') {
  return `ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=${sessionId}`;
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 10));
  }
}

test('a media socket without a device token is refused', async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port));
  const [error] = await once(ws, 'error');
  assert.match(error.message, /401/);
  await media.close();
});

test("another device's session is forbidden", async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port), { headers: { Authorization: 'Bearer tok-2' } });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
  await media.close();
});

test('an unknown session is not found', async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port, 'nope'), { headers: { Authorization: 'Bearer tok-1' } });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /404/);
  await media.close();
});

test('a valid socket drives the scripted engine and answers its final', async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port), { headers: { Authorization: 'Bearer tok-1' } });
  const frames = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(data.toString()));
  });
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));
  ws.send(Buffer.from([0, 0]));
  const final = await waitUntil(() => frames.find((frame) => frame.t === 'final'));
  assert.equal(final.text, 'from engine');
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  await media.close();
});

test('an oversized binary frame is refused', async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port), { headers: { Authorization: 'Bearer tok-1' } });
  await once(ws, 'open');
  const closed = once(ws, 'close');
  ws.send(Buffer.alloc(64 * 1024 + 1));
  const [code] = await closed;
  assert.equal(code, 1009);
  await media.close();
});

test('a socket with no audio for the timeout closes itself', async () => {
  const media = await startMedia({ noAudioTimeoutMs: 80 });
  const ws = new WebSocket(urlFor(media.port), { headers: { Authorization: 'Bearer tok-1' } });
  await once(ws, 'open');
  const [code] = await once(ws, 'close');
  assert.equal(code, 1001);
  await media.close();
});

test("the Gate's own token opens a bootstrap phone's session", async () => {
  const media = await startMedia({ tokenStore: BOOTSTRAP_TOKENS });
  const ws = new WebSocket(urlFor(media.port, 'vs-boot'), { headers: { Authorization: 'Bearer gate-own-token' } });
  await once(ws, 'open');
  ws.close();
  await media.close();
});

test("the Gate's own token cannot open a paired device's session", async () => {
  const media = await startMedia({ tokenStore: BOOTSTRAP_TOKENS });
  const ws = new WebSocket(urlFor(media.port, 'vs-1'), { headers: { Authorization: 'Bearer gate-own-token' } });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
  await media.close();
});

test('a device token cannot open a bootstrap session', async () => {
  const media = await startMedia({ tokenStore: BOOTSTRAP_TOKENS });
  const ws = new WebSocket(urlFor(media.port, 'vs-boot'), { headers: { Authorization: 'Bearer tok-1' } });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
  await media.close();
});

test('voice.session.start then audio in yields a scripted final and a reply', async () => {
  const { methods, registry } = createVoiceRpc({
    capabilities: () => ({
      enabled: true,
      engines: {
        local: { state: 'ready' },
        codex: { state: 'disabled', reason: 'no' },
      },
    }),
    makeId: () => 'vs-e2e',
  });
  const grant = await methods['voice.session.start'](
    { engine: 'local', thread: { kind: 'bot', sessionId: 's1', botId: 'b1' } },
    { deviceId: 'dev-1' },
  );
  assert.equal(grant.voiceSessionId, 'vs-e2e');
  assert.equal(grant.streamPath, '/v1/voice/stream');

  const deviceTokens = {
    verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const turns = [];
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => new ScriptedEngine({ text: 'hello from the operator', framesBeforeFinal: 1 }),
    runTurn: async (_session, text, handlers) => {
      turns.push(text);
      handlers.onDelta('hello back');
      return { hasContent: true };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${grant.streamPath}?voiceSessionId=${grant.voiceSessionId}`, {
    headers: { Authorization: 'Bearer tok-1' },
  });
  const frames = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(data.toString()));
  });
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));
  ws.send(Buffer.from([0, 0]));
  const final = await waitUntil(() => frames.find((frame) => frame.t === 'final'));
  assert.equal(final.text, 'hello from the operator');
  await waitUntil(() => turns.length > 0);
  assert.equal(turns[0], 'hello from the operator');
  await waitUntil(() => frames.some((frame) => frame.t === 'reply' && frame.delta === 'hello back'));
  ws.close();
  await once(ws, 'close');
  await new Promise((done) => {
    wss.close(() => server.close(done));
  });
});

test('an engine that will not open ends the call with a logged fatal error', async () => {
  const lines = [];
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-1', deviceId: 'dev-1', engine: 'local' });
  const deviceTokens = {
    verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    log: (line) => lines.push(line),
    createEngine: () => ({
      open: async () => {
        throw new Error('worker missing');
      },
      pushAudio() {},
      close() {},
      on() {},
    }),
  });
  server.listen(0);
  await once(server, 'listening');
  const ws = new WebSocket(urlFor(server.address().port), { headers: { Authorization: 'Bearer tok-1' } });
  const frames = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(data.toString()));
  });
  await once(ws, 'open');
  const fatal = await waitUntil(() => frames.find((frame) => frame.t === 'error' && frame.fatal));
  assert.equal(fatal.code, 'engine_open_failed');
  assert.match(fatal.message, /worker missing/);
  assert.ok(lines.some((line) => /engine-open fail/.test(line) && /worker missing/.test(line)));
  await once(ws, 'close');
  await new Promise((done) => {
    wss.close(() => server.close(done));
  });
});

// A controllable engine: the test decides when speech starts and ends, what a
// final says, and how speak answers — the barge-in and hang-up paths Scripted
// (which fires finals on audio alone) cannot model.
function makeControllableEngine() {
  const listeners = new Map();
  const engine = {
    open: async () => {},
    pushAudio: () => {},
    close: async () => {},
    cancelled: [],
    spoken: [],
    muted: false,
    on: (event, fn) => {
      listeners.set(event, fn);
      return engine;
    },
    emit: (event, payload) => listeners.get(event)?.(payload),
    speak: (text, { gen } = {}) => {
      engine.spoken.push({ text, gen });
    },
    cancelSpeech: (gen) => {
      engine.cancelled.push(gen);
    },
    setMuted: (muted) => {
      engine.muted = muted;
    },
  };
  return engine;
}

async function startControllableCall({
  engine,
  runTurn,
  resumeTimeoutMs = 20_000,
  turnTimeoutMs = 120_000,
} = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create(SESSION);
  const deviceTokens = {
    verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
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
    runTurn,
    resumeTimeoutMs,
    turnTimeoutMs,
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const frames = [];
  const openSocket = () => {
    const ws = new WebSocket(urlFor(port), { headers: { Authorization: 'Bearer tok-1' } });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) frames.push(JSON.parse(data.toString()));
    });
    return ws;
  };
  const first = openSocket();
  await once(first, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));
  return {
    frames,
    first,
    openSocket,
    registry,
    close: () =>
      new Promise((done) => {
        wss.close(() => server.close(done));
      }),
  };
}

test('barge-in cancels the spoken reply and reopens listening', async () => {
  const engine = makeControllableEngine();
  const call = await startControllableCall({
    engine,
    runTurn: async (_session, _text, handlers) => {
      handlers.onDelta('a long reply');
      return { hasContent: true };
    },
  });
  engine.emit('final', { text: 'turn one' });
  await waitUntil(() => call.frames.some((frame) => frame.t === 'reply'));
  assert.ok(engine.spoken.length > 0, 'the reply started speaking');
  const spokenGen = engine.spoken[0].gen;

  engine.emit('userSpeechStart', {});
  await waitUntil(() => call.frames.some((frame) => frame.t === 'phase' && frame.phase === 'listening'));
  assert.deepEqual(engine.cancelled, [spokenGen]);

  // A second turn still runs after the interruption.
  engine.emit('final', { text: 'turn two' });
  await waitUntil(() => call.frames.filter((frame) => frame.t === 'final').length >= 2);
  call.first.close();
  await once(call.first, 'close');
  await call.close();
});

test('hanging up during a reply aborts the turn and ends the call', async () => {
  const engine = makeControllableEngine();
  let abortSeen = false;
  const call = await startControllableCall({
    engine,
    runTurn: (_session, _text, handlers) =>
      new Promise((_resolve, reject) => {
        handlers.signal.addEventListener('abort', () => {
          abortSeen = true;
          reject(new Error('aborted'));
        });
      }),
  });
  engine.emit('final', { text: 'turn one' });
  await waitUntil(() => call.frames.some((frame) => frame.t === 'phase' && frame.phase === 'thinking'));
  // Attach before sending: the server answers ended + close in one breath, and
  // the close event can fire before a later once() would attach.
  const closed = once(call.first, 'close');
  call.first.send(JSON.stringify({ t: 'end' }));
  const ended = await waitUntil(() => call.frames.find((frame) => frame.t === 'ended'));
  assert.equal(ended.reason, 'user');
  await waitUntil(() => abortSeen);
  await closed;
  await call.close();
});

test('a dropped socket detaches, re-attaches within the window, and resumes', async () => {
  const engine = makeControllableEngine();
  const call = await startControllableCall({
    engine,
    runTurn: async () => ({ hasContent: true }),
    resumeTimeoutMs: 600,
  });
  // The drop: the first socket goes away mid-call.
  call.first.close();
  await once(call.first, 'close');

  // The Gate must not end the call while the window holds.
  await new Promise((done) => setTimeout(done, 100));
  assert.ok(!call.frames.some((frame) => frame.t === 'ended'));

  // The phone rejoins with the same session id and gets the live phase back.
  const second = call.openSocket();
  await once(second, 'open');
  await waitUntil(() => framesInclude(call.frames, (frame) => frame.t === 'ready' && frame.engine === 'local'));
  await waitUntil(() => call.frames.some((frame) => frame.t === 'phase' && frame.phase === 'listening'));
  second.close();
  await once(second, 'close');
  await call.close();
});

test('a call nobody rejoins ends with reason network when the window expires', async () => {
  const engine = makeControllableEngine();
  const call = await startControllableCall({
    engine,
    runTurn: async () => ({ hasContent: true }),
    resumeTimeoutMs: 200,
  });
  const closed = once(call.first, 'close');
  call.first.close();
  await closed;
  // The socket is gone, so the ended frame cannot reach the phone; the
  // registry is the observable side: the session ends with reason network.
  await waitUntil(
    () => {
      const session = call.registry.get(SESSION.voiceSessionId);
      return session?.ended ? session.endedReason : null;
    },
    3000,
  );
  assert.equal(call.registry.get(SESSION.voiceSessionId).endedReason, 'network');
  await call.close();
});

test('a turn that never answers is failed and listening reopens', async () => {
  const engine = makeControllableEngine();
  const call = await startControllableCall({
    engine,
    runTurn: () => new Promise(() => {}),
    turnTimeoutMs: 100,
  });
  engine.emit('final', { text: 'turn one' });
  await waitUntil(() => call.frames.some((frame) => frame.t === 'phase' && frame.phase === 'thinking'));
  const failed = await waitUntil(() =>
    call.frames.find((frame) => frame.t === 'turn' && frame.state === 'failed'),
  );
  assert.match(failed.error, /timed out/);
  await waitUntil(() => call.frames.some((frame) => frame.t === 'phase' && frame.phase === 'listening'));
  call.first.close();
  await once(call.first, 'close');
  await call.close();
});

function framesInclude(frames, predicate) {
  return frames.some(predicate);
}

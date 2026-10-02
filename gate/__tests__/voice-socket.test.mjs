import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import {
  ATTACHED_LIVENESS_MS,
  GRANT_ATTACH_GRACE_MS,
  VoiceSessionRegistry,
  createVoiceRpc,
} from '../core/voice/voice-rpc.mjs';
import { ScriptedEngine } from '../core/voice/engines/scripted-engine.mjs';

const TOKENS = { 'tok-1': { deviceId: 'dev-1' }, 'tok-2': { deviceId: 'dev-2' } };
const SESSION = { voiceSessionId: 'vs-1', deviceId: 'dev-1', engine: 'local' };
const BOOTSTRAP_SESSION = { voiceSessionId: 'vs-boot', deviceId: 'bootstrap:phone-abc123', engine: 'local' };
// The Gate's own token: a phone connected with it has no device grant.
const BOOTSTRAP_TOKENS = { verify: async (authorization) => authorization === 'Bearer gate-own-token' };

async function startMedia({ noAudioTimeoutMs = 30_000, tokenStore = null, utteranceHoldMs = 0 } = {}) {
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
    // The scripted engine's one final is one turn, at once: a hold of 0.
    utteranceHoldMs,
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
  // Every call leaves one summary line saying how far it got.
  const summary = await waitUntil(() => lines.find((line) => /^voice\.end /.test(line)));
  assert.match(summary, /audioFrames=0 audioBytes=0 partials=0 finals=0 speechChunks=0/);
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
  speculationWindowMs,
  utteranceHoldMs = 0,
  audit,
  log,
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
    speculationWindowMs,
    // These tests pin the plain turn loop and speculation as they were: one
    // final is one turn, at once, which is a hold of 0. The utterance hold and
    // what it gathers are covered in voice-utterance-socket.test.mjs.
    utteranceHoldMs,
    audit,
    ...(log ? { log } : {}),
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

test('a speculative reply arriving before final is delivered once after confirmation', async () => {
  const engine = makeControllableEngine();
  const turns = [];
  const audit = [];
  const call = await startControllableCall({
    engine,
    audit: (line) => audit.push(line),
    runTurn: async (_session, text, handlers) => {
      turns.push(text);
      handlers.onDelta('fast answer');
      return { hasContent: true };
    },
  });

  engine.emit('earlyEnd', { text: 'hello' });
  await waitUntil(() => turns.length === 1);
  await new Promise((done) => setTimeout(done, 20));
  assert.ok(!call.frames.some((frame) => frame.t === 'reply'));
  engine.emit('final', { text: 'hello' });
  const reply = await waitUntil(() => call.frames.find((frame) => frame.t === 'reply'));
  assert.equal(reply.delta, 'fast answer');
  assert.deepEqual(turns, ['hello']);

  const closed = once(call.first, 'close');
  call.first.send(JSON.stringify({ t: 'end' }));
  await closed;
  assert.equal(audit[0]?.turns, 1);
  await call.close();
});

test('a changed final aborts the speculative turn and keeps the replacement timeout', async () => {
  const engine = makeControllableEngine();
  const turns = [];
  let draftAborted = false;
  const call = await startControllableCall({
    engine,
    turnTimeoutMs: 80,
    runTurn: (_session, text, handlers) => {
      turns.push(text);
      if (text === 'corrected') return new Promise(() => {});
      return new Promise((_resolve, reject) => {
        handlers.signal.addEventListener('abort', () => {
          draftAborted = true;
          reject(new Error('draft aborted'));
        });
      });
    },
  });

  engine.emit('earlyEnd', { text: 'draft' });
  await waitUntil(() => turns.length === 1);
  engine.emit('final', { text: 'corrected' });
  await waitUntil(() => draftAborted && turns.length === 2);
  const failed = await waitUntil(() =>
    call.frames.find((frame) => frame.t === 'turn' && frame.state === 'failed'),
  );
  assert.match(failed.error, /timed out/);
  assert.deepEqual(turns, ['draft', 'corrected']);
  call.first.close();
  await once(call.first, 'close');
  await call.close();
});

test('a speculative replacement gets its own attempt id named in the stage log', async () => {
  const engine = makeControllableEngine();
  const lines = [];
  const attempts = [];
  const call = await startControllableCall({
    engine,
    log: (line) => lines.push(line),
    turnTimeoutMs: 80,
    runTurn: (_session, text, handlers) => {
      attempts.push({ text, attempt: handlers.attempt });
      handlers.onStage?.({ stage: 'turn.send', path: 'whole-turn', backend: 'hermes-live' });
      if (text === 'corrected') return new Promise(() => {});
      return new Promise((_resolve, reject) => {
        handlers.signal.addEventListener('abort', () => reject(new Error('draft aborted')));
      });
    },
  });

  engine.emit('earlyEnd', { text: 'draft' });
  await waitUntil(() => attempts.length === 1);
  engine.emit('final', { text: 'corrected' });
  await waitUntil(() => attempts.length === 2);

  assert.notEqual(attempts[0].attempt, attempts[1].attempt, 'each startTurn has a unique attempt id');
  const stageLines = lines.filter((line) => /voice\.turn stage/.test(line));
  assert.ok(stageLines.some((line) => /attempt=1 .*stage=turn\.send/.test(line)), stageLines.join('\n'));
  assert.ok(stageLines.some((line) => /attempt=2 .*stage=turn\.send/.test(line)), stageLines.join('\n'));
  assert.ok(
    stageLines.every((line) => /backend=hermes-live/.test(line)),
    'every stage line carries the backend descriptor',
  );

  call.first.close();
  await once(call.first, 'close');
  await call.close();
});

test('an early end without a final confirms after its speculation window', async () => {
  const engine = makeControllableEngine();
  const turns = [];
  const call = await startControllableCall({
    engine,
    speculationWindowMs: 30,
    runTurn: async (_session, text, handlers) => {
      turns.push(text);
      handlers.onDelta('answer');
      return { hasContent: true };
    },
  });

  engine.emit('earlyEnd', { text: 'hello' });
  const reply = await waitUntil(() => call.frames.find((frame) => frame.t === 'reply'));
  assert.equal(reply.delta, 'answer');
  assert.deepEqual(turns, ['hello']);
  call.first.close();
  await once(call.first, 'close');
  await call.close();
});

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

// The reservation a phone never released: it attached its media socket, then
// vanished — killed, dropped, or never reaching for `voice.session.stop` — and
// not one more frame crossed in either direction. The Gate must free the device
// for a retry, and the call that held it must go with the released reservation:
// releasing the record alone would leave the old call running next to the new
// session's, two media calls for one device.
test('releasing a stale reservation ends its media call before the device is handed to a new session', async () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  registry.create(SESSION);
  const { methods } = createVoiceRpc({
    capabilities: () => ({
      enabled: true,
      engines: {
        local: { state: 'ready' },
        codex: { state: 'disabled', reason: 'no key' },
      },
    }),
    registry,
    makeId: () => 'vs-2',
  });

  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const deviceTokens = {
    verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
  };
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => makeControllableEngine(),
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;

  const oldFrames = [];
  const first = new WebSocket(urlFor(port, SESSION.voiceSessionId), {
    headers: { Authorization: 'Bearer tok-1' },
  });
  first.on('message', (data, isBinary) => {
    if (!isBinary) oldFrames.push(JSON.parse(data.toString()));
  });
  const newFrames = [];
  let second = null;
  try {
    await once(first, 'open');
    await waitUntil(() => oldFrames.some((frame) => frame.t === 'ready'));

    // The phone is gone: no frame in either direction while the clock runs on.
    clock += ATTACHED_LIVENESS_MS + 1;

    const grant = await methods['voice.session.start'](
      { engine: 'local', thread: { kind: 'bot', sessionId: 's1', botId: 'b1' } },
      { deviceId: 'dev-1' },
    );
    assert.equal(grant.voiceSessionId, 'vs-2');

    // The abandoned call is over before the new session may begin: its phone
    // is told why, and its socket closes instead of running alongside.
    const ended = await waitUntil(() => oldFrames.find((frame) => frame.t === 'ended'), 500);
    assert.equal(ended.reason, 'abandoned');
    await waitUntil(() => first.readyState === WebSocket.CLOSED, 500);
    assert.equal(registry.get(SESSION.voiceSessionId).endedReason, 'abandoned');

    // The new session's socket opens on a Gate with exactly one live call.
    second = new WebSocket(urlFor(port, grant.voiceSessionId), {
      headers: { Authorization: 'Bearer tok-1' },
    });
    second.on('message', (data, isBinary) => {
      if (!isBinary) newFrames.push(JSON.parse(data.toString()));
    });
    await once(second, 'open');
    await waitUntil(() => newFrames.some((frame) => frame.t === 'ready'));
    assert.equal(registry.liveForDevice('dev-1').voiceSessionId, 'vs-2');
  } finally {
    first.close();
    second?.close();
    for (const client of wss.clients) client.terminate();
    await new Promise((done) => {
      wss.close(() => server.close(done));
    });
  }
});

// The other half of the stale reservation: a grant that never attached at all.
// `liveForDevice` stops counting it as live once its grace lapses, so a retry
// takes the device — but the abandoned record itself was left open. A socket
// that arrives late (the phone wedged through the grace, then finally dials)
// could still open the released session and run a call beside the replacement:
// two media calls for one device. The released grant must be ended, not merely
// skipped, so the late upgrade is refused exactly as an ended session is.
test('a socket that arrives after its grant lapsed is refused, not run beside the replacement call', async () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  registry.create(SESSION);
  const { methods } = createVoiceRpc({
    capabilities: () => ({
      enabled: true,
      engines: {
        local: { state: 'ready' },
        codex: { state: 'disabled', reason: 'no key' },
      },
    }),
    registry,
    makeId: () => 'vs-2',
  });

  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const deviceTokens = {
    verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
  };
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => makeControllableEngine(),
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;

  let late = null;
  try {
    // The first grant never opened a socket; its grace lapses and a retry takes
    // the device with a fresh session.
    clock += GRANT_ATTACH_GRACE_MS + 1;
    const grant = await methods['voice.session.start'](
      { engine: 'local', thread: { kind: 'bot', sessionId: 's1', botId: 'b1' } },
      { deviceId: 'dev-1' },
    );
    assert.equal(grant.voiceSessionId, 'vs-2');

    // The late socket names the session the retry superseded; it must be refused,
    // not started as the second live call on this device.
    late = new WebSocket(urlFor(port, SESSION.voiceSessionId), {
      headers: { Authorization: 'Bearer tok-1' },
    });
    await assert.rejects(() => once(late, 'open'));
    assert.equal(registry.get(SESSION.voiceSessionId).ended, true);
    assert.equal(registry.liveForDevice('dev-1').voiceSessionId, 'vs-2');
  } finally {
    late?.close();
    for (const client of wss.clients) client.terminate();
    await new Promise((done) => {
      wss.close(() => server.close(done));
    });
  }
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

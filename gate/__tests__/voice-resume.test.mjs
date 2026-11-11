import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry, createVoiceRpc } from '../core/voice/voice-rpc.mjs';

class FakeEngine extends EventEmitter {
  constructor({ autoDone = true } = {}) {
    super();
    this.id = 'local';
    this.autoDone = autoDone;
    this.spoken = [];
    this.cancelled = [];
    this.muted = false;
    this.closed = false;
  }

  async open() {}

  pushAudio() {
    this.emit('final', { text: 'turn text' });
  }

  speak(text, { gen, final } = {}) {
    this.spoken.push({ text, gen, final });
    this.emit('speechAudio', { gen, pcm: Buffer.from([7, 7]) });
    if (this.autoDone) setImmediate(() => this.emit('speechDone', { gen }));
  }

  cancelSpeech(gen) {
    this.cancelled.push(gen);
  }

  setMuted(muted) {
    this.muted = muted;
  }

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

async function startMedia({
  runTurn,
  engine = new FakeEngine(),
  resumeTimeoutMs,
  audit,
  utteranceHoldMs = 0,
  log,
} = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create(SESSION);
  const deviceTokens = {
    verify: async (authorization) => (String(authorization) === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
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
    audit,
    log,
    // A resume test is about the socket, not turn-taking: one final is one turn,
    // at once, which is a hold of 0 (see voice-utterance-socket.test.mjs).
    utteranceHoldMs,
  });
  server.listen(0);
  await once(server, 'listening');
  return {
    port: server.address().port,
    engine,
    registry,
    endAll: (reason) => wss.endAll(reason),
    close: () =>
      new Promise((done) => {
        wss.close(() => server.close(done));
      }),
  };
}

function urlFor(port) {
  return `ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=vs-1`;
}

function connect(port) {
  const ws = new WebSocket(urlFor(port), { headers: { Authorization: 'Bearer tok-1' } });
  const frames = [];
  let binary = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary) binary += 1;
    else frames.push(JSON.parse(data.toString()));
  });
  return { ws, frames, binary: () => binary };
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 10));
  }
}

test('a dropped socket re-attaches and keeps the call, flushing buffered speech', async () => {
  let release;
  const runTurn = (_session, _text, { onDelta }) => {
    onDelta('A spoken sentence.');
    return new Promise((resolve) => {
      release = () => resolve({ hasContent: true });
    });
  };
  const engine = new FakeEngine({ autoDone: false });
  const media = await startMedia({ runTurn, engine });
  const first = connect(media.port);
  await once(first.ws, 'open');
  await waitUntil(() => first.frames.some((frame) => frame.t === 'ready'));

  first.ws.send(Buffer.from([0, 0]));
  await waitUntil(() => first.frames.some((frame) => frame.t === 'reply'));
  const gen = engine.spoken[0]?.gen;

  const closed = once(first.ws, 'close');
  first.ws.close();
  await closed;
  await new Promise((done) => setTimeout(done, 30));

  engine.emit('speechAudio', { gen, pcm: Buffer.from([9, 9]) });

  const second = connect(media.port);
  await once(second.ws, 'open');
  await waitUntil(() => second.frames.some((frame) => frame.t === 'ready'));
  await waitUntil(() => second.frames.some((frame) => frame.t === 'phase' && frame.phase === 'speaking'));
  await waitUntil(() => second.binary() >= 1);
  assert.equal(engine.closed, false, 'the call is still alive');
  assert.equal(second.frames.some((frame) => frame.t === 'ended'), false);

  release?.();
  second.ws.close();
  await once(second.ws, 'close');
  await media.close();
});

test('a call that ends leaves one audit summary for the sink', async () => {
  const engine = new FakeEngine();
  const recorded = [];
  const media = await startMedia({
    runTurn: async (_session, _text, { onDelta }) => {
      onDelta('Hi.');
      return { hasContent: true };
    },
    engine,
    audit: (summary) => recorded.push(summary),
  });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  ws.send(Buffer.from([0, 0]));
  await waitUntil(() => frames.some((frame) => frame.t === 'turn' && frame.state === 'done'));

  media.endAll('gate-restart');
  await waitUntil(() => recorded.length === 1);
  assert.equal(recorded[0].engine, 'local');
  assert.equal(recorded[0].deviceId, 'dev-1');
  assert.equal(recorded[0].turns, 1);
  assert.equal(recorded[0].error, 'gate-restart');
  await media.close();
});

test('a call that is never resumed ends with reason network', async () => {
  const engine = new FakeEngine();
  const media = await startMedia({ runTurn: async () => ({ hasContent: true }), engine, resumeTimeoutMs: 80 });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  const closed = once(ws, 'close');
  ws.close();
  await closed;

  await waitUntil(() => media.registry.get('vs-1').ended === true, 3000);
  assert.equal(engine.closed, true);
  await media.close();
});

test('a call whose socket detached is superseded, not refused, by the same phone starting again', async () => {
  const lines = [];
  let release;
  const runTurn = (_session, _text, { onDelta }) => {
    onDelta('A spoken sentence.');
    return new Promise((resolve) => {
      release = () => resolve({ hasContent: true });
    });
  };
  const engine = new FakeEngine({ autoDone: false });
  const media = await startMedia({ runTurn, engine, log: (line) => lines.push(line) });
  // The same registry the call's socket reads: a start and the call it opens
  // cannot disagree about which device is on a call.
  const rpc = createVoiceRpc({
    registry: media.registry,
    capabilities: () => ({
      enabled: true,
      engines: {
        local: { state: 'ready' },
        codex: { state: 'disabled', reason: 'Codex realtime needs an API key' },
      },
      limits: { codexMinutesPerDay: 60, maxConcurrentCalls: 1 },
      usedToday: { localMinutes: 0, codexMinutes: 0 },
    }),
    makeId: () => 'vs-2',
    log: (line) => lines.push(line),
  });
  const ctx = { deviceId: 'dev-1' };
  const thread = { kind: 'bot', sessionId: 'sess-1', botId: 'scout' };

  const call = connect(media.port);
  await once(call.ws, 'open');
  await waitUntil(() => call.frames.some((frame) => frame.t === 'ready'));
  // A turn is in flight when the link dies — the case a supersede must not
  // throw away.
  call.ws.send(Buffer.from([0, 0]));
  await waitUntil(() => typeof release === 'function');

  // While the socket is on the call, the phone's next start is refused.
  await assert.rejects(
    () => rpc.methods['voice.session.start']({ engine: 'local', thread }, ctx),
    (error) => error.code === 'call_in_progress',
  );

  // The phone closes its own media socket the way `HandsfreeGateMedia.stop()`
  // does — a clean 1000 — so the Gate's close line names the side that left.
  const closed = once(call.ws, 'close');
  call.ws.close(1000, 'call ended');
  await closed;
  await waitUntil(() => media.registry.isDetached('vs-1'));
  // The Gate log says which side closed the link and how far the call got, so
  // the next one of these is not a guess.
  await waitUntil(() => lines.some((line) => /voice\.stream close session=vs-1 code=1000/.test(line)));

  // The operator dials again inside the 90 s the Gate would have held the old
  // call: a new call opens instead of `call_in_progress`.
  const grant = await rpc.methods['voice.session.start']({ engine: 'local', thread }, ctx);
  assert.equal(grant.voiceSessionId, 'vs-2');
  assert.equal(media.registry.get('vs-1').ended, true);
  assert.equal(media.registry.get('vs-1').endedReason, 'abandoned');
  assert.equal(media.registry.liveForDevice('dev-1').voiceSessionId, 'vs-2');

  // The old call's turn is parked, not cancelled: its reply is still owed to
  // the thread the operator spoke into.
  await waitUntil(() => lines.some((line) => /voice\.turn parked session=vs-1/.test(line)));
  assert.equal(engine.closed, true);

  release?.();
  await media.close();
});

test('a Gate shutdown ends every live call with a named reason', async () => {
  const engine = new FakeEngine();
  const media = await startMedia({ runTurn: async () => ({ hasContent: true }), engine });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  media.endAll('gate-restart');
  await waitUntil(() => frames.some((frame) => frame.t === 'ended' && frame.reason === 'gate-restart'));
  assert.equal(engine.closed, true);
  assert.equal(media.registry.get('vs-1').ended, true);

  await media.close();
});

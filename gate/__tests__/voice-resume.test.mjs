import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

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

async function startMedia({ runTurn, engine = new FakeEngine(), resumeTimeoutMs, audit } = {}) {
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

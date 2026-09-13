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

async function startMedia({ runTurn, engine = new FakeEngine() } = {}) {
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
  });
  server.listen(0);
  await once(server, 'listening');
  return {
    port: server.address().port,
    engine,
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

test('a final runs the Bot turn and speaks its sentences', async () => {
  const calls = [];
  const runTurn = async (session, text, { onDelta }) => {
    calls.push({ thread: session.thread, text });
    onDelta('Hi there. ');
    onDelta('How are you?');
    return { hasContent: true };
  };
  const media = await startMedia({ runTurn });
  const { ws, frames, binary } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  ws.send(Buffer.from([0, 0]));
  await waitUntil(() => frames.some((frame) => frame.t === 'turn' && frame.state === 'done'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].thread.sessionId, 'sess-1');
  assert.equal(calls[0].text, 'turn text');
  assert.deepEqual(media.engine.spoken.map((entry) => entry.text), ['Hi there. ', 'How are you?']);
  assert.ok(frames.some((frame) => frame.t === 'final' && frame.text === 'turn text'));
  assert.ok(frames.some((frame) => frame.t === 'reply' && frame.delta === 'Hi there. '));
  assert.ok(binary() >= 1, 'the speech PCM reached the phone as binary');

  ws.close();
  await once(ws, 'close');
  await media.close();
});

test('a phone barge-in cancels only the generation being spoken', async () => {
  let release;
  const runTurn = (_session, _text, { onDelta }) => {
    onDelta('A spoken sentence.');
    return new Promise((resolve) => {
      release = () => resolve({ hasContent: true });
    });
  };
  const engine = new FakeEngine({ autoDone: false });
  const media = await startMedia({ runTurn, engine });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  ws.send(Buffer.from([0, 0]));
  await waitUntil(() => frames.some((frame) => frame.t === 'reply'));
  const gen = engine.spoken[0]?.gen;

  ws.send(JSON.stringify({ t: 'bargein' }));
  await waitUntil(() => engine.cancelled.length === 1);
  assert.equal(engine.cancelled[0], gen);
  assert.ok(frames.some((frame) => frame.t === 'phase' && frame.phase === 'listening'));

  release?.();
  ws.close();
  await once(ws, 'close');
  await media.close();
});

test('the engine hearing speech cancels the live generation', async () => {
  let release;
  const runTurn = (_session, _text, { onDelta }) => {
    onDelta('A spoken sentence.');
    return new Promise((resolve) => {
      release = () => resolve({ hasContent: true });
    });
  };
  const engine = new FakeEngine({ autoDone: false });
  const media = await startMedia({ runTurn, engine });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  ws.send(Buffer.from([0, 0]));
  await waitUntil(() => frames.some((frame) => frame.t === 'reply'));
  const gen = engine.spoken[0]?.gen;

  engine.emit('userSpeechStart', {});
  await waitUntil(() => engine.cancelled.length === 1);
  assert.equal(engine.cancelled[0], gen);
  assert.ok(frames.some((frame) => frame.t === 'phase' && frame.phase === 'listening'));

  release?.();
  ws.close();
  await once(ws, 'close');
  await media.close();
});

test('a userSpeechStart while listening is inert', async () => {
  const engine = new FakeEngine({ autoDone: false });
  const media = await startMedia({ runTurn: async () => ({ hasContent: true }), engine });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  engine.emit('userSpeechStart', {});
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(engine.cancelled.length, 0);
  assert.equal(frames.filter((frame) => frame.t === 'phase' && frame.phase === 'listening').length, 1);

  ws.close();
  await once(ws, 'close');
  await media.close();
});

test('an early end starts the turn before the final promotes it', async () => {
  let release;
  const signals = [];
  const runTurn = (_session, _text, { signal, onDelta }) => {
    signals.push(signal);
    return new Promise((resolve) => {
      release = () => {
        onDelta('Speculative reply.');
        resolve({ hasContent: true });
      };
    });
  };
  const engine = new FakeEngine({ autoDone: false });
  const media = await startMedia({ runTurn, engine });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  engine.emit('earlyEnd', { text: 'hello' });
  await waitUntil(() => signals.length === 1);

  // Stay quiet past the 600 ms abort window, then final promotes the turn.
  await new Promise((done) => setTimeout(done, 650));
  engine.emit('final', { text: 'hello' });
  await waitUntil(() => frames.some((frame) => frame.t === 'final'));
  assert.equal(signals.length, 1, 'the running turn was promoted, not restarted');

  release();
  await waitUntil(() => frames.some((frame) => frame.t === 'turn' && frame.state === 'done'));
  assert.ok(frames.some((frame) => frame.t === 'reply' && frame.delta === 'Speculative reply.'));

  ws.close();
  await once(ws, 'close');
  await media.close();
});

test('a userSpeechStart within the abort window discards the speculative turn', async () => {
  const signals = [];
  const runTurn = (_session, _text, { signal }) => {
    signals.push(signal);
    return new Promise(() => {});
  };
  const engine = new FakeEngine({ autoDone: false });
  const media = await startMedia({ runTurn, engine });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  engine.emit('earlyEnd', { text: 'partial' });
  await waitUntil(() => signals.length === 1);

  engine.emit('userSpeechStart', {});
  await waitUntil(() => signals[0].aborted === true);

  engine.emit('final', { text: 'the real turn' });
  await waitUntil(() => signals.length === 2);
  assert.equal(signals[1].aborted, false, 'the final starts a fresh turn');

  assert.equal(frames.some((frame) => frame.t === 'reply'), false, 'the discarded turn left no reply');
  assert.equal(
    frames.some((frame) => frame.t === 'turn' && frame.state === 'done'),
    false,
    'the discarded turn left no turn done',
  );

  ws.close();
  await once(ws, 'close');
  await media.close();
});

test('each complete sentence is spoken while the reply is still arriving', async () => {
  let release;
  const runTurn = (_session, _text, { onDelta }) => {
    onDelta('First one. ');
    onDelta('Second one.');
    return new Promise((resolve) => {
      release = () => resolve({ hasContent: true });
    });
  };
  const engine = new FakeEngine({ autoDone: false });
  const media = await startMedia({ runTurn, engine });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  ws.send(Buffer.from([0, 0]));
  await waitUntil(() => engine.spoken.length === 2);
  assert.deepEqual(media.engine.spoken.map((entry) => entry.text), ['First one. ', 'Second one.']);
  assert.equal(
    frames.some((frame) => frame.t === 'turn' && frame.state === 'done'),
    false,
    'the sentences were spoken before the turn resolved',
  );

  release();
  await waitUntil(() => frames.some((frame) => frame.t === 'turn' && frame.state === 'done'));
  ws.close();
  await once(ws, 'close');
  await media.close();
});

test('end from any path converges on exactly one ended frame', async () => {
  const media = await startMedia({ runTurn: async () => ({ hasContent: true }) });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  ws.send(JSON.stringify({ t: 'end' }));
  await waitUntil(() => frames.some((frame) => frame.t === 'ended'));
  media.engine.emit('error', { fatal: true, code: 'engine_error', message: 'boom' });
  ws.close();
  await once(ws, 'close');

  assert.equal(frames.filter((frame) => frame.t === 'ended').length, 1);
  await media.close();
});

test('a turn runner that throws fails the turn instead of hanging it', async () => {
  const media = await startMedia({
    runTurn: async () => {
      throw new Error('backend exploded');
    },
  });
  const { ws, frames } = connect(media.port);
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));

  ws.send(Buffer.from([0, 0]));
  const failed = await waitUntil(() => frames.find((frame) => frame.t === 'turn' && frame.state === 'failed'));
  assert.equal(failed.error, 'backend exploded');

  ws.close();
  await once(ws, 'close');
  await media.close();
});

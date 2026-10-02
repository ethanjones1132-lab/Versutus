// "Listening" is a claim about the engine, not about the socket: a cold local
// worker takes tens of seconds to load its models, and every PCM frame written
// to that pipe before it was read by nobody (a live call, 2026-10-02: the first
// transcript 17.9 s after the stream opened). These tests pin the gate the
// media socket puts between an attached phone and an engine that cannot hear.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

const SESSION = { voiceSessionId: 'vs-1', deviceId: 'dev-1', engine: 'local' };

/** An engine whose `open` the test resolves when it chooses to. */
function makeEngine() {
  const listeners = new Map();
  let opened;
  const engine = {
    audio: [],
    open: () => new Promise((resolve) => { opened = resolve; }),
    isOpening: () => Boolean(opened),
    finishOpen: () => opened?.(),
    pushAudio(frame) {
      engine.audio.push(Buffer.from(frame));
    },
    close: async () => {},
    on: (event, fn) => listeners.set(event, fn),
    emit: (event, payload) => listeners.get(event)?.(payload),
  };
  return engine;
}

async function startMedia({ engine, engineOpenTimeoutMs, resumeTimeoutMs = 20_000, log } = {}) {
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
    ...(engineOpenTimeoutMs === undefined ? {} : { engineOpenTimeoutMs }),
    resumeTimeoutMs,
    ...(log ? { log } : {}),
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const frames = [];
  const openSocket = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=vs-1`, {
      headers: { Authorization: 'Bearer tok-1' },
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) frames.push(JSON.parse(data.toString()));
    });
    return ws;
  };
  return {
    frames,
    registry,
    openSocket,
    close: () =>
      new Promise((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(done));
      }),
  };
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 10));
  }
}

test('the first attach says opening, and listening waits for the engine', async () => {
  const engine = makeEngine();
  const media = await startMedia({ engine });
  const ws = media.openSocket();
  await once(ws, 'open');
  await waitUntil(() => media.frames.length > 0);

  assert.deepEqual(media.frames, [{ t: 'phase', phase: 'opening' }], 'the phone is connected, not heard from');
  assert.equal(media.frames.some((frame) => frame.t === 'ready'), false);

  engine.finishOpen();
  const ready = await waitUntil(() => media.frames.find((frame) => frame.t === 'ready'));
  assert.equal(ready.engine, 'local');
  assert.deepEqual(
    media.frames.map((frame) => [frame.t, frame.phase]),
    [['phase', 'opening'], ['phase', 'listening'], ['ready', undefined]],
  );

  ws.close();
  await once(ws, 'close');
  await media.close();
});

test('audio sent before the engine is ready is dropped, counted, and delivered after', async () => {
  const lines = [];
  const engine = makeEngine();
  const media = await startMedia({ engine, log: (line) => lines.push(line) });
  const ws = media.openSocket();
  await once(ws, 'open');
  await waitUntil(() => media.frames.length > 0);

  for (let index = 0; index < 3; index += 1) ws.send(Buffer.from([index, 0]));
  await new Promise((done) => setTimeout(done, 60));
  assert.equal(engine.audio.length, 0, 'nothing is pushed into an engine that is not open');

  engine.finishOpen();
  await waitUntil(() => media.frames.some((frame) => frame.t === 'ready'));
  ws.send(Buffer.from([9, 0]));
  await waitUntil(() => engine.audio.length === 1);
  assert.deepEqual(engine.audio[0], Buffer.from([9, 0]), 'audio reaches the engine once it can hear');

  // Attach before the end: the server answers an end control with the ended
  // frame and a close in one breath, and close can fire before a later once().
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ t: 'end' }));
  await waitUntil(() => lines.some((line) => /^voice\.end /.test(line)));
  await closed;
  const summary = lines.find((line) => /^voice\.end /.test(line));
  assert.match(summary, /audioFramesEarly=3/, 'the frames that were thrown away are named');
  assert.match(summary, /audioFrames=4 audioBytes=8/);
  await media.close();
});

test('an engine that never opens hits the deadline and ends the call', async () => {
  const engine = makeEngine();
  const media = await startMedia({ engine, engineOpenTimeoutMs: 60 });
  const ws = media.openSocket();
  await once(ws, 'open');
  const closed = once(ws, 'close');

  const fatal = await waitUntil(() => media.frames.find((frame) => frame.t === 'error' && frame.fatal));
  assert.equal(fatal.code, 'engine_open_failed');
  assert.match(fatal.message, /did not start within 60ms/);
  await waitUntil(() => media.registry.get(SESSION.voiceSessionId).ended);
  assert.equal(media.registry.get(SESSION.voiceSessionId).endedReason, 'engine');
  await closed;
  await media.close();
});

test('a re-attach keeps the frames it always sent', async () => {
  const engine = makeEngine();
  const media = await startMedia({ engine, resumeTimeoutMs: 2_000 });
  const first = media.openSocket();
  await once(first, 'open');
  await waitUntil(() => media.frames.length > 0);
  engine.finishOpen();
  await waitUntil(() => media.frames.some((frame) => frame.t === 'ready'));

  first.close();
  await once(first, 'close');
  media.frames.length = 0;
  const second = media.openSocket();
  await once(second, 'open');
  const ready = await waitUntil(() => media.frames.find((frame) => frame.t === 'ready'));

  assert.equal(ready.engine, 'local');
  // `ready` has always named the window the Gate holds the call for since the
  // 90 s resume work (voice-call-durability.test.mjs); a re-attach repeats it.
  assert.deepEqual(media.frames[0], { t: 'ready', engine: 'local', resumeWindowMs: 2_000 });
  assert.deepEqual(media.frames[1], { t: 'phase', phase: 'listening' });

  second.close();
  await once(second, 'close');
  await media.close();
});

test('a re-attach while the engine is still opening is not told listening', async () => {
  const engine = makeEngine();
  const media = await startMedia({ engine, resumeTimeoutMs: 2_000 });
  const first = media.openSocket();
  await once(first, 'open');
  await waitUntil(() => media.frames.length > 0);

  // The engine has not opened: the call is still `opening`, and a phone that
  // re-attaches now must hear that. Claiming `ready`/`listening` here is a call
  // that says it can hear while every PCM frame is dropped on the floor.
  first.close();
  await once(first, 'close');
  media.frames.length = 0;

  const second = media.openSocket();
  await once(second, 'open');
  await waitUntil(() => media.frames.length > 0);
  assert.deepEqual(
    media.frames,
    [{ t: 'phase', phase: 'opening' }],
    'a re-attach before the engine can hear says opening, not listening',
  );

  // When the engine finally opens, the ready/listening pair arrives once, in
  // that order, exactly as on a first attach.
  engine.finishOpen();
  await waitUntil(() => media.frames.some((frame) => frame.t === 'ready'));
  assert.deepEqual(
    media.frames.map((frame) => [frame.t, frame.phase]),
    [['phase', 'opening'], ['phase', 'listening'], ['ready', undefined]],
  );

  second.close();
  await once(second, 'close');
  await media.close();
});

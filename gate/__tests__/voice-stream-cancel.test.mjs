import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { attachVoiceMediaSocket, MAX_SPEECH_CHUNK_MS, OUTPUT_SAMPLE_RATE } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

const wait = async (predicate) => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for voice frame');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function callHarness(t) {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-stream', deviceId: 'device', engine: 'local' });
  const listeners = new Map();
  const engine = {
    open: async () => {},
    close: async () => {},
    on: (name, listener) => listeners.set(name, listener),
    emit: (name, value) => listeners.get(name)?.(value),
    speak: (_text, options) => { engine.gen = options.gen; },
    cancelSpeech: () => {},
  };
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async (auth) => auth === 'Bearer token' ? { deviceId: 'device' } : null },
    registry,
    createEngine: () => engine,
    runTurn: async (_session, _text, handlers) => {
      handlers.onDelta('A complete sentence.');
      return { hasContent: true };
    },
    utteranceHoldMs: 0,
  });
  server.listen(0);
  await once(server, 'listening');
  const received = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/voice/stream?voiceSessionId=vs-stream`, {
    headers: { Authorization: 'Bearer token' },
  });
  ws.on('message', (data, binary) => received.push(binary ? Buffer.from(data) : JSON.parse(data.toString())));
  t.after(() => new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => server.close(resolve));
  }));
  await once(ws, 'open');
  await wait(() => received.some((frame) => frame?.t === 'ready'));
  engine.emit('final', { text: 'question' });
  await wait(() => engine.gen !== undefined);
  return { engine, received, ws };
}

test('speech is chunked and a speech onset cancels without sending stale audio', async (t) => {
  const { engine, received } = await callHarness(t);
  assert.equal(received.some((frame) => frame?.t === 'speech' && frame.state === 'start'), false,
    'reply text alone does not start playback');
  const pcm = Buffer.alloc(24_000 * 2 * 35 / 100, 7);
  engine.emit('speechAudio', { gen: engine.gen, pcm });
  await wait(() => received.some(Buffer.isBuffer));
  const firstAudioIndex = received.findIndex(Buffer.isBuffer);
  const startIndex = received.findIndex((frame) => frame?.t === 'speech' && frame.state === 'start');
  assert.ok(startIndex >= 0 && startIndex < firstAudioIndex, 'start is emitted with the first PCM chunk');

  const pcmChunks = received.filter(Buffer.isBuffer);
  const maxBytes = OUTPUT_SAMPLE_RATE * 2 * MAX_SPEECH_CHUNK_MS / 1000;
  assert.ok(pcmChunks.length > 1);
  assert.ok(pcmChunks.every((chunk) => chunk.length <= maxBytes));
  // The Gate hears the onset in the PCM it already receives; the phone has no
  // separate barge-in control.
  engine.emit('userSpeechStart', {});
  await wait(() => received.some((frame) => frame?.t === 'speech' && frame.state === 'cancelled'));
  const cancelIndex = received.findIndex((frame) => frame?.t === 'speech' && frame.state === 'cancelled');
  const chunksBefore = received.filter(Buffer.isBuffer).length;
  engine.emit('speechAudio', { gen: engine.gen, pcm: Buffer.alloc(48, 1) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.filter(Buffer.isBuffer).length, chunksBefore, 'no chunk from the cancelled generation follows cancellation');
  assert.ok(cancelIndex > firstAudioIndex);

  const cancelledGen = engine.gen;
  engine.emit('final', { text: 'next question' });
  await wait(() => engine.gen > cancelledGen);
  const nextGen = engine.gen;
  engine.emit('speechAudio', { gen: nextGen, pcm: Buffer.alloc(960, 2) });
  await wait(() => received.some((frame) => frame?.t === 'speech' && frame.gen === nextGen && frame.state === 'start'));
  const lifecycle = received.filter((frame) => frame?.t === 'speech').map(({ gen, state }) => ({ gen, state }));
  assert.deepEqual(lifecycle, [
    { gen: cancelledGen, state: 'start' },
    { gen: cancelledGen, state: 'cancelled' },
    { gen: nextGen, state: 'start' },
  ]);
});

test('normal playback emits one start and one end without cancellation', async (t) => {
  const { engine, received } = await callHarness(t);
  const pcm = Buffer.alloc(960, 3);
  engine.emit('speechAudio', { gen: engine.gen, pcm });
  await wait(() => received.some(Buffer.isBuffer));
  engine.emit('speechDone', { gen: engine.gen });
  await wait(() => received.some((frame) => frame?.t === 'speech' && frame.state === 'end'));

  const states = received.filter((frame) => frame?.t === 'speech').map((frame) => frame.state);
  assert.deepEqual(states, ['start', 'end']);
});

test('skip cancels the reply and suppresses its later audio', async (t) => {
  const { engine, received, ws } = await callHarness(t);
  engine.emit('speechAudio', { gen: engine.gen, pcm: Buffer.alloc(960, 1) });
  await wait(() => received.some(Buffer.isBuffer));
  ws.send(JSON.stringify({ t: 'skip' }));
  await wait(() => received.some((frame) => frame?.t === 'speech' && frame.state === 'cancelled'));
  const chunksBefore = received.filter(Buffer.isBuffer).length;
  engine.emit('speechAudio', { gen: engine.gen, pcm: Buffer.alloc(48, 1) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.filter(Buffer.isBuffer).length, chunksBefore, 'skip drops later audio from the cancelled generation');
});

test('mute leaves the reply playing and sends its remaining chunks', async (t) => {
  const { engine, received, ws } = await callHarness(t);
  engine.emit('speechAudio', { gen: engine.gen, pcm: Buffer.alloc(960, 1) });
  await wait(() => received.some(Buffer.isBuffer));
  const chunksBeforeMute = received.filter(Buffer.isBuffer).length;
  ws.send(JSON.stringify({ t: 'mute', on: true }));
  await wait(() => received.some((frame) => frame?.t === 'phase' && frame.phase === 'muted'));
  assert.equal(received.some((frame) => frame?.t === 'speech' && frame.state === 'cancelled'), false);

  const remaining = Buffer.alloc(24_000 * 2 * 35 / 100, 1);
  engine.emit('speechAudio', { gen: engine.gen, pcm: remaining });
  const maxBytes = OUTPUT_SAMPLE_RATE * 2 * MAX_SPEECH_CHUNK_MS / 1000;
  const expectedChunks = Math.ceil(remaining.length / maxBytes);
  await wait(() => received.filter(Buffer.isBuffer).length >= chunksBeforeMute + expectedChunks);
  const remainingChunks = received.filter(Buffer.isBuffer).slice(chunksBeforeMute);
  assert.equal(remainingChunks.length, expectedChunks);
  assert.ok(remainingChunks.every((chunk) => chunk.length <= maxBytes));
  assert.equal(received.some((frame) => frame?.t === 'speech' && frame.state === 'cancelled'), false);
});

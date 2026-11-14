import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { attachVoiceMediaSocket, VOICE_STREAM_PATH } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

function fakeEngine() {
  const listeners = new Map();
  const engine = {
    open: async () => {},
    close: async () => {},
    pushAudio: () => {},
    // W5: playback starts with the first PCM chunk, so the test needs the
    // reducer's generation before it can feed audio. The engine's speak effect
    // is where that generation is assigned.
    speak: (_text, options) => { engine.gen = options.gen; },
    on(name, listener) {
      listeners.set(name, listener);
      return this;
    },
    emit(name, payload) {
      listeners.get(name)?.(payload);
    },
  };
  return engine;
}

async function startCall(t, { sessionId, protocol, runTurn, log = () => {} }) {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: sessionId, deviceId: 'device-1', engine: 'local' });
  const engine = fakeEngine();
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async () => ({ deviceId: 'device-1' }) },
    registry,
    createEngine: () => engine,
    runTurn,
    log,
    utteranceHoldMs: 0,
  });
  t.after(() => new Promise((resolve) => {
    // End the calls first so their resume timers are cleared, then free the
    // sockets and the server; an unref'd timer would still be a leak.
    wss.endAll('test-cleanup');
    for (const client of wss.clients) client.terminate();
    wss.close(() => server.close(resolve));
  }));
  server.listen(0);
  await once(server, 'listening');
  const frames = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=${sessionId}&protocol=${protocol}`,
    { headers: { Authorization: 'Bearer token' } },
  );
  ws.on('message', (data, binary) => { if (!binary) frames.push(JSON.parse(data.toString())); });
  await once(ws, 'open');
  await until(() => frames.some((frame) => frame.t === 'ready'));
  return { engine, frames, ws };
}

test('a v2 call carries the tool lifecycle without its arguments or output', async (t) => {
  const { engine, frames } = await startCall(t, {
    sessionId: 'vs-tools',
    protocol: 2,
    runTurn: async (_session, _text, handlers) => {
      handlers.onToolCall({ index: 0, name: 'read', callId: 'call-1' });
      handlers.onToolCall({
        index: 0,
        name: 'read',
        callId: 'call-1',
        status: 'complete',
        detail: 'SECRET-OUTPUT',
      });
      handlers.onDelta('Done.');
      return { hasContent: true };
    },
  });

  engine.emit('final', { text: 'read it' });
  await until(() => frames.filter((frame) => frame.t === 'tool').length === 2);
  const [running, complete] = frames.filter((frame) => frame.t === 'tool');
  const final = frames.find((frame) => frame.t === 'final');

  assert.equal(running.v, 2);
  assert.equal(running.callId, 'vs-tools');
  assert.ok(running.seq > 0);
  assert.equal(running.turnId, final.turnId);
  assert.deepEqual(
    [running.toolId, running.name, running.status, running.summary],
    ['call-1', 'read', 'running', 'read running'],
  );
  assert.equal(complete.status, 'complete');
  assert.equal(complete.summary, 'read complete');
  assert.ok(!JSON.stringify(frames).includes('SECRET-OUTPUT'), 'raw tool detail never reaches the wire');
});

test('a v1 call keeps its old stream free of the new tool frames', async (t) => {
  const { engine, frames } = await startCall(t, {
    sessionId: 'vs-tools-v1',
    protocol: 1,
    runTurn: async (_session, _text, handlers) => {
      handlers.onToolCall({ index: 0, name: 'read', callId: 'call-1' });
      handlers.onDelta('Done.');
      return { hasContent: true };
    },
  });

  engine.emit('final', { text: 'read it' });
  await until(() => frames.some((frame) => frame.t === 'turn' && frame.state === 'done'));
  assert.equal(frames.some((frame) => frame.t === 'tool'), false);
  assert.ok(frames.every((frame) => frame.v === undefined));
});

test('a played control is consumed as the turn latency sample', async (t) => {
  const logs = [];
  const { engine, frames, ws } = await startCall(t, {
    sessionId: 'vs-played',
    protocol: 2,
    log: (line) => logs.push(line),
    runTurn: async (_session, _text, handlers) => {
      handlers.onDelta('A sentence.');
      return { hasContent: true };
    },
  });

  engine.emit('final', { text: 'time it' });
  // W5: `start` now marks real playback, so it leaves with the first PCM chunk
  // rather than with the reply text. Feed audio, then read the frame.
  await until(() => typeof engine.gen === 'number');
  engine.emit('speechAudio', { gen: engine.gen, pcm: Buffer.alloc(960, 5) });
  await until(() => frames.some((frame) => frame.t === 'speech' && frame.state === 'start'));
  const gen = frames.find((frame) => frame.t === 'speech' && frame.state === 'start').gen;
  ws.send(JSON.stringify({ v: 2, callId: 'vs-played', seq: 1, ts: 0, t: 'played', gen, atMs: 42 }));

  await until(() => logs.some((line) => line.includes('voice.turn latency') && line.includes('playedMs=42')));
});

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the expected voice frame');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';

import { attachVoiceMediaSocket, VOICE_STREAM_PATH } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

class SlowReaderEngine extends EventEmitter {
  async open() {}
  async close() {}
  pushAudio() {}
  speak() {}
  cancelSpeech() {}
  setMuted() {}
}

test('a slow or detached v2 reader never grows the reliable replay log without bound', async (t) => {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-slow', deviceId: 'dev-1', engine: 'local' });
  const engine = new SlowReaderEngine();
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async () => ({ deviceId: 'dev-1' }) },
    registry,
    createEngine: () => engine,
    maxBufferedFrames: 5,
  });
  t.after(() => closeResources({ registry, sessionId: 'vs-slow', wss, server }));
  server.listen(0);
  await once(server, 'listening');
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-slow&protocol=2`,
    { headers: { Authorization: 'Bearer token' } },
  );
  const frames = [];
  ws.on('message', (data, binary) => { if (!binary) frames.push(JSON.parse(data.toString())); });
  await once(ws, 'open');
  const ready = await waitFor(() => frames.find((frame) => frame.t === 'phase' && frame.phase === 'listening'));
  assert.equal(ready.v, 2);
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  await waitFor(() => registry.isDetached('vs-slow'));

  // Partials coalesce while detached, so use reliable error controls to exercise
  // the replay-frame cap rather than the interim-text replacement path.
  for (let index = 0; index < 6; index += 1) {
    engine.emit('error', { code: 'test_error', message: `error ${index}`, fatal: false });
  }
  await waitFor(() => registry.get('vs-slow')?.ended === true);
  assert.equal(registry.get('vs-slow').endedReason, 'backpressure');
});

test('a paused v2 reader bounds queued PCM to two seconds plus one chunk', async (t) => {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-slow-live', deviceId: 'dev-1', engine: 'local' });
  const engine = new SlowReaderEngine();
  let gateSocket;
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async () => ({ deviceId: 'dev-1' }) },
    registry,
    createEngine: (_session, socket) => { gateSocket = socket; return engine; },
  });
  t.after(() => closeResources({ registry, sessionId: 'vs-slow-live', wss, server }));
  server.listen(0);
  await once(server, 'listening');
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-slow-live&protocol=2`,
    { headers: { Authorization: 'Bearer token' } },
  );
  const frames = [];
  ws.on('message', (data, binary) => { if (!binary) frames.push(JSON.parse(data.toString())); });
  await once(ws, 'open');
  await waitFor(() => frames.find((frame) => frame.t === 'phase' && frame.phase === 'listening'));
  ws._socket.pause();
  engine.emit('speechAudio', { gen: 0, pcm: Buffer.alloc(5 * 1024 * 1024) });
  const liveLimit = 2 * 24_000 * 2;
  assert.ok(gateSocket.bufferedAmount > 0);
  assert.ok(gateSocket.bufferedAmount <= liveLimit + 4_808);
  const closed = once(ws, 'close');
  // A paused TCP reader cannot receive the peer's close handshake.
  ws._socket.resume();
  ws.close();
  await closed;
});

async function closeResources({ registry, sessionId, wss, server }) {
  registry.end(sessionId, 'test-cleanup');
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

async function waitFor(read, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for bounded queue result');
}

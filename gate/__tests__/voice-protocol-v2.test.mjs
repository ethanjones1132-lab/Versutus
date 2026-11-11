import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { attachVoiceMediaSocket, VOICE_STREAM_PATH } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';
import { ScriptedEngine } from '../core/voice/engines/scripted-engine.mjs';

test('a v2 phone and Gate negotiate the enveloped call handshake before controls', async () => {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-1', deviceId: 'dev-1', engine: 'local' });
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async (header) => (header === 'Bearer token' ? { deviceId: 'dev-1' } : null) },
    registry,
    createEngine: () => new ScriptedEngine({ text: 'ok' }),
    utteranceHoldMs: 0,
  });
  server.listen(0);
  await once(server, 'listening');
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-1&protocol=2`,
    { headers: { Authorization: 'Bearer token' } },
  );
  const received = [];
  socket.on('message', (data, binary) => { if (!binary) received.push(JSON.parse(data.toString())); });
  await once(socket, 'open');
  const opening = await waitFor(() => received[0]);
  assert.deepEqual([opening.v, opening.callId, opening.seq, opening.t, opening.state], [2, 'vs-1', 1, 'call', 'opening']);
  socket.send(JSON.stringify({ v: 2, callId: 'vs-1', seq: 1, ts: 0, t: 'mute', on: true }));
  const ready = await waitFor(() => received.find((frame) => frame.t === 'ready'));
  assert.equal(ready.v, 2);
  assert.ok(ready.seq > opening.seq);
  assert.equal(typeof ready.ts, 'number');
  const close = once(socket, 'close');
  socket.close();
  await close;
  await new Promise((resolve) => wss.close(() => server.close(resolve)));
});

test('a v1 phone connected to the new Gate keeps the flat v1 contract', async () => {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-v1', deviceId: 'dev-1', engine: 'local' });
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async (header) => (header === 'Bearer token' ? { deviceId: 'dev-1' } : null) },
    registry,
    createEngine: () => new ScriptedEngine({ text: 'ok' }),
    utteranceHoldMs: 0,
  });
  server.listen(0);
  await once(server, 'listening');
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-v1`,
    { headers: { Authorization: 'Bearer token' } },
  );
  const received = [];
  socket.on('message', (data, binary) => { if (!binary) received.push(JSON.parse(data.toString())); });
  await once(socket, 'open');
  const opening = await waitFor(() => received[0]);
  assert.deepEqual(opening, { t: 'phase', phase: 'opening' });
  socket.send(JSON.stringify({ t: 'mute', on: true }));
  await waitFor(() => received.find((frame) => frame.t === 'ready'));
  assert.ok(received.every((frame) => frame.v === undefined));
  const close = once(socket, 'close');
  socket.close();
  await close;
  await new Promise((resolve) => wss.close(() => server.close(resolve)));
});

function waitFor(read, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const value = read();
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for frame'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

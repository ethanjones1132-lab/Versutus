import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';

import { attachVoiceMediaSocket, VOICE_STREAM_PATH } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

class ResumeEngine extends EventEmitter {
  async open() {}
  async close() {}
  pushAudio() {}
  speak() {}
  cancelSpeech() {}
  setMuted() {}
}

async function waitFor(read, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for v2 replay');
}

test('v2 reconnect resumes after the contiguous cursor and replays retained controls in order', async (t) => {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-resume', deviceId: 'dev-1', engine: 'local' });
  const engine = new ResumeEngine();
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async (header) => header === 'Bearer token' ? { deviceId: 'dev-1' } : null },
    registry,
    createEngine: () => engine,
    utteranceHoldMs: 0,
  });
  t.after(() => closeResources({ registry, sessionId: 'vs-resume', wss, server }));
  server.listen(0);
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-resume&protocol=2`;
  const connect = () => {
    const ws = new WebSocket(url, { headers: { Authorization: 'Bearer token' } });
    const frames = [];
    ws.on('message', (data, binary) => { if (!binary) frames.push(JSON.parse(data.toString())); });
    return { ws, frames };
  };

  const first = connect();
  await once(first.ws, 'open');
  await waitFor(() => first.frames.find((frame) => frame.t === 'phase' && frame.phase === 'listening'));
  const cursor = Math.max(...first.frames.map((frame) => frame.seq));
  const firstClose = once(first.ws, 'close');
  first.ws.close();
  await firstClose;
  await waitFor(() => registry.isDetached('vs-resume'));

  engine.emit('partial', { text: 'superseded interim text' });
  engine.emit('partial', { text: 'retained after link loss' });
  const second = connect();
  await once(second.ws, 'open');
  await waitFor(() => second.frames.some((frame) => frame.t === 'call' && frame.seq === 1));
  second.ws.send(JSON.stringify({ v: 2, callId: 'vs-resume', seq: 1, ts: 0, t: 'resume', lastSeq: cursor }));
  const replayed = await waitFor(() => second.frames.find((frame) => frame.t === 'partial'));
  assert.equal(replayed.text, 'retained after link loss');
  assert.ok(replayed.seq > cursor);
  const afterResume = second.frames.filter((frame) => frame.seq > cursor);
  assert.deepEqual(afterResume.map((frame) => frame.seq), [...afterResume.map((frame) => frame.seq)].sort((a, b) => a - b));

  const secondClose = once(second.ws, 'close');
  second.ws.close();
  await secondClose;
});

async function closeResources({ registry, sessionId, wss, server }) {
  registry.end(sessionId, 'test-cleanup');
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { attachVoiceMediaSocket, VOICE_STREAM_PATH } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';
import { ScriptedEngine } from '../core/voice/engines/scripted-engine.mjs';

test('v2 PCM chunks carry the active generation and speech-start sequence', async (t) => {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-chunk', deviceId: 'dev-1', engine: 'local' });
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async () => ({ deviceId: 'dev-1' }) },
    registry,
    createEngine: () => new ScriptedEngine({ minSpeechMs: 20 }),
    runTurn: async (_session, _text, { onDelta }) => { onDelta('Hi.'); return { hasContent: true }; },
    utteranceHoldMs: 0,
  });
  t.after(() => closeResources({ registry, sessionId: 'vs-chunk', wss, server }));
  server.listen(0);
  await once(server, 'listening');
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-chunk&protocol=2`,
    { headers: { Authorization: 'Bearer token' } },
  );
  const frames = [];
  let chunk = null;
  ws.on('message', (data, binary) => {
    if (binary) chunk = Buffer.from(data);
    else frames.push(JSON.parse(data.toString()));
  });
  await once(ws, 'open');
  await waitFor(() => frames.find((frame) => frame.t === 'phase' && frame.phase === 'listening'));
  ws.send(Buffer.from([0, 0]));
  const audio = await waitFor(() => chunk);
  const start = frames.find((frame) => frame.t === 'speech' && frame.state === 'start');
  assert.ok(start);
  assert.equal(audio.readUInt32BE(0), start.gen);
  assert.equal(audio.readUInt32BE(4), start.seq);
  assert.equal(audio.length, 8 + 960);
  const closed = once(ws, 'close');
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
  throw new Error('timed out waiting for v2 audio');
}

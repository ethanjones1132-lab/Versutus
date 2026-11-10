import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';
import { ScriptedEngine } from '../core/voice/engines/scripted-engine.mjs';

test('a muted silent call stays open, then an unmuted silent call times out', async () => {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-muted-watchdog', deviceId: 'dev-1', engine: 'local' });
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async (value) => value === 'Bearer token' ? { deviceId: 'dev-1' } : null },
    registry,
    createEngine: () => new ScriptedEngine({ text: 'unused' }),
    noAudioTimeoutMs: 80,
  });
  server.listen(0);
  await once(server, 'listening');
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-muted-watchdog`,
    { headers: { Authorization: 'Bearer token' } },
  );
  // Listen before the socket opens: the Gate can send `ready` in the same
  // read as the upgrade, before an 'open' handler would get to attach.
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for Gate ready')), 5000);
    ws.on('message', (data, binary) => {
      if (binary || JSON.parse(data.toString()).t !== 'ready') return;
      clearTimeout(timeout);
      resolve();
    });
  });
  try {
    await once(ws, 'open');
    await ready;
    ws.send(JSON.stringify({ t: 'mute', on: true }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(ws.readyState, WebSocket.OPEN, 'mute suspends the no-audio watchdog');

    ws.send(JSON.stringify({ t: 'mute', on: false }));
    const [code] = await once(ws, 'close');
    assert.equal(code, 1001, 'unmuted silence remains subject to the watchdog');
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await new Promise((resolve) => wss.close(() => server.close(resolve)));
  }
});

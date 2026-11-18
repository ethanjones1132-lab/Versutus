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

test('v2 mute after resume suspends idle even before the voice engine opens', { timeout: 5_000 }, async () => {
  const callId = 'vs-muted-resume-opening';
  let now = 0;
  const registry = new VoiceSessionRegistry({ now: () => now });
  registry.create({ voiceSessionId: callId, deviceId: 'dev-1', engine: 'local' });
  const server = createServer();
  const engine = new ScriptedEngine();
  let finishOpening;
  const openingEngine = new Promise((resolve) => { finishOpening = resolve; });
  engine.open = () => openingEngine;
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async (value) => value === 'Bearer token' ? { deviceId: 'dev-1' } : null },
    registry,
    createEngine: () => engine,
    now: () => now,
    noAudioTimeoutMs: 40,
  });
  server.listen(0);
  await once(server, 'listening');
  const clients = [];
  const connect = async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=${callId}&protocol=2`,
      { headers: { Authorization: 'Bearer token' } },
    );
    clients.push(ws);
    const [data] = await once(ws, 'message', { signal: AbortSignal.timeout(1_000) });
    const hello = JSON.parse(data.toString());
    assert.equal(hello.state, 'opening');
    return { ws, hello };
  };
  const ping = async (ws) => {
    const pong = once(ws, 'pong', { signal: AbortSignal.timeout(1_000) });
    ws.ping();
    await pong;
  };
  try {
    const first = await connect();
    const closed = once(first.ws, 'close');
    first.ws.terminate();
    await closed;
    const { ws } = await connect();
    const control = (seq, frame) => ws.send(JSON.stringify({ v: 2, callId, seq, ts: now, ...frame }));
    control(1, { t: 'resume', lastSeq: first.hello.seq });
    control(2, { t: 'mute', on: true });
    await ping(ws); // Both controls preceded this ping on the wire.

    now = 200;
    await new Promise((resolve) => setTimeout(resolve, 100)); // More than two watchdog checks.
    assert.equal(ws.readyState, WebSocket.OPEN, 'mute survives the watchdog while the engine is opening');
    assert.equal(registry.get(callId).lastSeenAt, 0);
    await ping(ws);
    assert.equal(registry.get(callId).lastSeenAt, now, 'muted pings keep the attachment lease live');

    const nextFrame = once(ws, 'message', { signal: AbortSignal.timeout(1_000) });
    finishOpening();
    const [data] = await nextFrame;
    const phase = JSON.parse(data.toString());
    assert.deepEqual([phase.t, phase.phase], ['phase', 'muted']);
    assert.equal(engine.muted, true);

    const idle = once(ws, 'close', { signal: AbortSignal.timeout(1_000) });
    control(3, { t: 'mute', on: false });
    await ping(ws);
    now += 200;
    const [code, reason] = await idle;
    assert.equal(code, 1001);
    assert.equal(reason.toString(), 'idle');
  } finally {
    finishOpening();
    wss.endAll();
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    await new Promise((resolve) => wss.close(() => server.close(resolve)));
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';
import { ScriptedEngine } from '../core/voice/engines/scripted-engine.mjs';

const TOKENS = { 'tok-1': { deviceId: 'dev-1' }, 'tok-2': { deviceId: 'dev-2' } };
const SESSION = { voiceSessionId: 'vs-1', deviceId: 'dev-1', engine: 'local' };

async function startMedia({ noAudioTimeoutMs = 30_000 } = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create(SESSION);
  const deviceTokens = {
    verify: async (authorization) => {
      const [scheme, token] = String(authorization ?? '').split(' ');
      if (scheme !== 'Bearer' || !token) return null;
      return TOKENS[token] ?? null;
    },
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => new ScriptedEngine({ text: 'from engine', framesBeforeFinal: 1 }),
    noAudioTimeoutMs,
  });
  server.listen(0);
  await once(server, 'listening');
  return {
    port: server.address().port,
    registry,
    close: () =>
      new Promise((done) => {
        wss.close(() => server.close(done));
      }),
  };
}

function urlFor(port, sessionId = 'vs-1') {
  return `ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=${sessionId}`;
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 10));
  }
}

test('a media socket without a device token is refused', async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port));
  const [error] = await once(ws, 'error');
  assert.match(error.message, /401/);
  await media.close();
});

test("another device's session is forbidden", async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port), { headers: { Authorization: 'Bearer tok-2' } });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
  await media.close();
});

test('an unknown session is not found', async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port, 'nope'), { headers: { Authorization: 'Bearer tok-1' } });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /404/);
  await media.close();
});

test('a valid socket drives the scripted engine and answers its final', async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port), { headers: { Authorization: 'Bearer tok-1' } });
  const frames = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(data.toString()));
  });
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));
  ws.send(Buffer.from([0, 0]));
  const final = await waitUntil(() => frames.find((frame) => frame.t === 'final'));
  assert.equal(final.text, 'from engine');
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  await media.close();
});

test('an oversized binary frame is refused', async () => {
  const media = await startMedia();
  const ws = new WebSocket(urlFor(media.port), { headers: { Authorization: 'Bearer tok-1' } });
  await once(ws, 'open');
  const closed = once(ws, 'close');
  ws.send(Buffer.alloc(64 * 1024 + 1));
  const [code] = await closed;
  assert.equal(code, 1009);
  await media.close();
});

test('a socket with no audio for the timeout closes itself', async () => {
  const media = await startMedia({ noAudioTimeoutMs: 80 });
  const ws = new WebSocket(urlFor(media.port), { headers: { Authorization: 'Bearer tok-1' } });
  await once(ws, 'open');
  const [code] = await once(ws, 'close');
  assert.equal(code, 1001);
  await media.close();
});

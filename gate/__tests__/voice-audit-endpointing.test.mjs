// Endpointing counters (O2): the per-call audit and the end line must say how
// many finals the call dropped as no-speech, how many times the operator talked
// over a reply, and how many speech onsets the playback echo gate refused.
// Counts only: the words stay in the thread, never on disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

const SESSION = { voiceSessionId: 'vs-endpointing', deviceId: 'dev-1', engine: 'local' };

function makeControllableEngine() {
  const listeners = new Map();
  const engine = {
    open: async () => {},
    pushAudio: () => {},
    close: async () => {},
    spoken: [],
    cancelled: [],
    on: (event, fn) => {
      listeners.set(event, fn);
      return engine;
    },
    emit: (event, payload) => listeners.get(event)?.(payload),
    speak: (text, { gen } = {}) => engine.spoken.push({ text, gen }),
    cancelSpeech: (gen) => engine.cancelled.push(gen),
  };
  return engine;
}

async function waitUntil(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 5));
  }
}

async function startCall(t, { engine, runTurn }) {
  const registry = new VoiceSessionRegistry();
  registry.create(SESSION);
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const audit = [];
  const lines = [];
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: {
      verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
    },
    registry,
    createEngine: () => engine,
    runTurn,
    audit: (summary) => audit.push(summary),
    log: (line) => lines.push(line),
    utteranceHoldMs: 0,
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(
    () => new Promise((done) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(done));
    }),
  );
  const frames = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-endpointing`,
    { headers: { Authorization: 'Bearer tok-1' } },
  );
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(data.toString()));
  });
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));
  return {
    frames,
    audit,
    lines,
    engine,
    end: async () => {
      const closed = once(ws, 'close');
      ws.send(JSON.stringify({ t: 'end' }));
      await waitUntil(() => audit.length === 1);
      await closed;
    },
  };
}

const logged = (lines, pattern) => lines.filter((line) => pattern.test(line));

test('the audit counts dropped no-speech, barge-ins and echo-gated onsets', async (t) => {
  const engine = makeControllableEngine();
  const call = await startCall(t, {
    engine,
    runTurn: async (_session, _text, handlers) => {
      handlers.onDelta('It will rain in Glasgow.');
      return { hasContent: true };
    },
  });

  // Two finals Whisper found no speech in, and one echo the playback gate
  // refused while the PC was talking. Neither is a turn, so both have to be
  // counted somewhere the end line can show them.
  engine.emit('noSpeechDrop', {});
  engine.emit('noSpeechDrop', {});
  engine.emit('echoGated', {});

  engine.emit('final', { text: 'what is the weather' });
  await waitUntil(() => call.frames.some((frame) => frame.t === 'phase' && frame.phase === 'speaking'));

  // The operator talks over the reply: one barge-in, and the speech stops.
  engine.emit('userSpeechStart', { gen: engine.spoken[0].gen });
  await waitUntil(() => call.frames.some((frame) => frame.t === 'phase' && frame.phase === 'listening'));

  await call.end();
  assert.deepEqual(
    {
      spuriousDrops: call.audit[0].spuriousDrops,
      bargeIns: call.audit[0].bargeIns,
      echoGated: call.audit[0].echoGated,
    },
    { spuriousDrops: 2, bargeIns: 1, echoGated: 1 },
  );
  assert.equal(logged(call.lines, /^voice\.final dropped /).length, 2, 'each dropped final is named');
  assert.equal(logged(call.lines, /^voice\.echo gated /).length, 1);
  assert.match(
    logged(call.lines, /^voice\.end /)[0],
    /spuriousDrops=2 bargeIns=1 echoGated=1/,
    'the end line carries the same counts as the audit',
  );
});

test('a call that took no interruptions reports zero, not a missing field', async (t) => {
  const call = await startCall(t, {
    engine: makeControllableEngine(),
    runTurn: async () => ({ hasContent: true }),
  });

  await call.end();
  assert.deepEqual(
    {
      spuriousDrops: call.audit[0].spuriousDrops,
      bargeIns: call.audit[0].bargeIns,
      echoGated: call.audit[0].echoGated,
    },
    { spuriousDrops: 0, bargeIns: 0, echoGated: 0 },
  );
});

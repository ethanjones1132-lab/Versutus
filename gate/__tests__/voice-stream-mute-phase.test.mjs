// ─── One mute state: the Gate's phase frame is part of it ───────────────────
// The phone folds Mute the moment it is tapped and then waits for the Gate's own
// `phase` frame to confirm it. If the Gate never sends that frame the two
// surfaces disagree for the rest of the call: the phone's capture is off, the
// Gate's engine is still hearing, and the banner has nothing to fold.
//
// The gap was the phase the operator mutes from most: a turn already sent and
// still being thought about. The reducer refused `mute` outside listening and
// speaking, so that tap produced no frame at all — and in v2 the same tap left
// the phone's fold waiting five seconds for a sequence number that was never
// allocated.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

const CALL_ID = 'vs-mute-phase';

const wait = async (predicate, what = 'voice frame') => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const phases = (received, phase) => received
  .filter((frame) => frame?.t === 'phase' && frame.phase === phase);

async function muteHarness(t, { protocol = 1 } = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: CALL_ID, deviceId: 'device', engine: 'local' });
  const listeners = new Map();
  const engine = {
    muted: false,
    open: async () => {},
    close: async () => {},
    on: (name, listener) => listeners.set(name, listener),
    emit: (name, value) => listeners.get(name)?.(value),
    speak: (_text, options) => { engine.gen = options.gen; },
    cancelSpeech: () => {},
    setMuted: (muted) => { engine.muted = muted; },
  };
  // The turn is held open: this is the call's `thinking` phase, which is where
  // an operator reaches for Mute and where the Gate used to ignore it.
  let finishTurn;
  const turnHeld = new Promise((resolve) => { finishTurn = resolve; });
  const server = createServer();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async (auth) => (auth === 'Bearer token' ? { deviceId: 'device' } : null) },
    registry,
    createEngine: () => engine,
    runTurn: async () => {
      await turnHeld;
      return { hasContent: true };
    },
    utteranceHoldMs: 0,
  });
  server.listen(0);
  await once(server, 'listening');
  const received = [];
  const query = protocol === 2
    ? `?voiceSessionId=${CALL_ID}&protocol=2`
    : `?voiceSessionId=${CALL_ID}`;
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/voice/stream${query}`, {
    headers: { Authorization: 'Bearer token' },
  });
  ws.on('message', (data, binary) => received.push(
    binary ? Buffer.from(data) : JSON.parse(data.toString()),
  ));
  t.after(() => new Promise((resolve) => {
    finishTurn();
    for (const client of wss.clients) client.terminate();
    wss.close(() => server.close(resolve));
  }));
  await once(ws, 'open');
  await wait(() => received.some((frame) => frame?.t === 'ready'), 'the ready frame');
  if (protocol === 2) {
    await wait(
      () => received.some((frame) => frame?.t === 'call' && frame.state === 'opening'),
      'the call frame',
    );
  }
  let phoneSeq = 0;
  const control = (frame) => {
    phoneSeq += 1;
    const body = protocol === 2
      ? { v: 2, callId: CALL_ID, seq: phoneSeq, ts: 0, ...frame }
      : frame;
    ws.send(JSON.stringify(body));
  };
  return { engine, received, ws, control };
}

test('a mute taken while the turn is in flight comes back as phase: muted', async (t) => {
  const { engine, received, control } = await muteHarness(t);

  engine.emit('final', { text: 'book a table for two' });
  await wait(
    () => phases(received, 'thinking').length > 0,
    'the thinking phase',
  );
  assert.equal(engine.muted, false);

  control({ t: 'mute', on: true });
  await wait(
    () => phases(received, 'muted').length > 0,
    'the muted phase after a mute control',
  );
  assert.equal(engine.muted, true, 'the Gate mutes the engine it owns');

  // The turn it interrupted is still owed its reply, and unmute goes back to it
  // rather than reopening a microphone under an answer nobody has heard yet.
  control({ t: 'mute', on: false });
  await wait(
    () => phases(received, 'thinking').length > 1,
    'the thinking phase the unmute returns to',
  );
  assert.equal(engine.muted, false);
});

test('the muted phase is a sequenced v2 frame with no gap in front of it', async (t) => {
  const { engine, received, control } = await muteHarness(t, { protocol: 2 });

  const opening = received.find((frame) => frame?.t === 'call' && frame.state === 'opening');
  assert.equal(opening.v, 2);
  assert.equal(opening.callId, CALL_ID);

  engine.emit('final', { text: 'book a table for two' });
  await wait(
    () => phases(received, 'thinking').length > 0,
    'the thinking phase',
  );

  control({ t: 'mute', on: true });
  await wait(
    () => phases(received, 'muted').length > 0,
    'the muted phase after a mute control',
  );

  // The phone's fold moves its cursor only on seq === last + 1. Every frame this
  // call produced is numbered in order, so the muted frame is one the app keeps
  // rather than one it drops (and, with it, every frame after it).
  const sequenced = received.filter((frame) => frame?.v === 2);
  for (let index = 1; index < sequenced.length; index += 1) {
    assert.equal(
      sequenced[index].seq,
      sequenced[index - 1].seq + 1,
      `seq ${sequenced[index].seq} does not follow ${sequenced[index - 1].seq}`,
    );
  }
  const muted = phases(received, 'muted')[0];
  assert.equal(muted.v, 2);
  assert.equal(muted.callId, CALL_ID);
  assert.ok(
    muted.seq > phases(received, 'thinking')[0].seq,
    'the muted phase is allocated after the phase it confirms',
  );
});

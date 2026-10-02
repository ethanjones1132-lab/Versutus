// A dropped phone link must interrupt nothing except the data transmission: the
// call and its turn carry on on the PC, the phone catches up on what it missed,
// and the reply reaches it as a notification and as thread history.
import test from 'node:test';
import { buildAuditLine } from '../core/voice/audit.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import {
  RESUME_TIMEOUT_MS,
  VOICE_STREAM_PATH,
  attachVoiceMediaSocket,
} from '../core/voice/media-socket.mjs';
import { parseGateFrame } from '../core/voice/protocol.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

// Mock timers stand in for the clock the call arms its own bounds with, so a
// 90 s window is walked in milliseconds. The real timer is kept for the waits:
// the socket is a real one, so its frames arrive on real I/O, not on the mock's.
const realSetTimeout = globalThis.setTimeout;

const SESSION = {
  voiceSessionId: 'vs-1',
  deviceId: 'dev-1',
  engine: 'local',
  thread: { kind: 'bot', sessionId: 'sess-1', botId: 'scout' },
};

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => realSetTimeout(done, 5));
  }
}

/** Walk the mocked clock, letting the call's own microtasks run between steps. */
async function advanceClock(t, totalMs, stepMs = 1_000) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    t.mock.timers.tick(stepMs);
    await new Promise((done) => setImmediate(done));
  }
}

/** Let the far end of a real socket notice a drop before the clock moves on. */
async function settle() {
  await new Promise((done) => realSetTimeout(done, 25));
}

/** A call the test drives: it decides when speech starts and ends, and what a
 *  final says, so a link that drops mid-reply can be staged exactly. */
function makeControllableEngine() {
  const listeners = new Map();
  const engine = {
    id: 'local',
    spoken: [],
    cancelled: [],
    opened: false,
    closed: false,
    muted: false,
    open: async () => {
      engine.opened = true;
    },
    pushAudio: () => {},
    close: async () => {
      engine.closed = true;
    },
    on: (event, fn) => {
      listeners.set(event, fn);
      return engine;
    },
    emit: (event, payload) => listeners.get(event)?.(payload),
    speak: (text, { gen, final } = {}) => {
      engine.spoken.push({ text, gen, final });
    },
    cancelSpeech: (gen) => {
      engine.cancelled.push(gen);
    },
    setMuted: (muted) => {
      engine.muted = muted;
    },
  };
  return engine;
}

/** A turn the test releases by hand, so a reply can stream over any span. */
function controllableTurn() {
  const turn = { handlers: null, released: false, aborted: false };
  const runTurn = (_session, text, handlers) => {
    turn.text = text;
    turn.handlers = handlers;
    return new Promise((resolve, reject) => {
      turn.release = (result = { hasContent: true }) => {
        turn.released = true;
        resolve(result);
      };
      handlers.signal.addEventListener('abort', () => {
        turn.aborted = true;
        reject(new Error('turn aborted'));
      });
    });
  };
  return { turn, runTurn };
}

async function startCall({ engine, runTurn, ...options } = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create({ ...SESSION });
  const deviceTokens = {
    verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => engine,
    runTurn,
    // These tests are about the link, not about turn-taking: one final is one
    // turn at once (voice-utterance-socket.test.mjs covers the hold).
    utteranceHoldMs: 0,
    ...options,
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const sockets = [];
  const openSocket = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=vs-1`, {
      headers: { Authorization: 'Bearer tok-1' },
    });
    // Control frames and audio in one ordered log: what "in order" means can
    // only be checked against the stream the phone actually receives.
    const entries = [];
    ws.on('message', (data, isBinary) => {
      entries.push(isBinary ? { binary: true, data } : { frame: JSON.parse(data.toString()) });
    });
    const socket = {
      ws,
      entries,
      frames: () => entries.filter((entry) => entry.frame).map((entry) => entry.frame),
      drop: async () => {
        const closed = once(ws, 'close');
        ws.terminate();
        await closed;
        await settle();
      },
    };
    sockets.push(socket);
    return socket;
  };
  const first = openSocket();
  await once(first.ws, 'open');
  await waitFor(() => first.entries.some((entry) => entry.frame?.t === 'ready'));
  return {
    first,
    openSocket,
    registry,
    endAll: (reason) => wss.endAll(reason),
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.ws.terminate();
        wss.close(() => server.close(done));
      }),
  };
}

/** What a phone sees, in order: `frame:reply` or `audio:7`. */
function shape(socket) {
  return socket.entries.map((entry) => (entry.binary ? `audio:${entry.data[0]}` : `frame:${entry.frame.t}`));
}

test('the ready frame names the window the Gate will hold the call for', async (t) => {
  // The app re-connects on its own ladder; the Gate has to say how long it will
  // wait so the two match instead of the phone giving up first.
  assert.equal(RESUME_TIMEOUT_MS, 90_000);
  const engine = makeControllableEngine();
  const call = await startCall({ engine, runTurn: async () => ({ hasContent: true }) });
  t.after(() => call.close());

  const ready = call.first.frames().find((frame) => frame.t === 'ready');
  assert.equal(ready.resumeWindowMs, 90_000);
  // The Gate's own parser accepts what it sends, and an older frame without the
  // field still parses.
  assert.equal(parseGateFrame(JSON.stringify(ready)).resumeWindowMs, 90_000);
  assert.deepEqual(parseGateFrame(JSON.stringify({ t: 'ready', engine: 'local' })), {
    t: 'ready',
    engine: 'local',
  });
});

test('a reply streams into a call with no phone for 40 s, replays on re-attach, and ends network only after the whole window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const engine = makeControllableEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall({ engine, runTurn });
  t.after(() => call.close());
  const first = call.first;

  engine.emit('final', { text: 'turn one' });
  await waitFor(() => turn.handlers);
  const gen = 1;

  // The link drops with the turn still running: Tailscale stutter, a locked
  // screen, a tunnel.
  await first.drop();
  await advanceClock(t, 20_000);
  assert.equal(call.registry.get('vs-1').ended, false, 'the 20 s the call used to wait for is not the end of it');
  assert.equal(turn.aborted, false, 'the turn keeps running with no phone to hear it');

  // The reply lands while nobody is listening: deltas, speech and audio.
  await advanceClock(t, 5_000);
  turn.handlers.onDelta('Here is the answer. ');
  engine.emit('speechAudio', { gen, pcm: Buffer.from([1, 1]) });
  engine.emit('speechAudio', { gen, pcm: Buffer.from([2, 2]) });
  engine.emit('speechAudio', { gen, pcm: Buffer.from([3, 3]) });
  await advanceClock(t, 14_000);
  turn.handlers.onDelta('And the rest of it.');
  await advanceClock(t, 10_000);
  turn.release({ hasContent: true });
  await new Promise((done) => setImmediate(done));
  engine.emit('speechDone', { gen });
  await advanceClock(t, 10_000);
  assert.equal(call.registry.get('vs-1').ended, false, '40 s without a phone is not the end of the call');
  assert.equal(engine.closed, false);

  // The phone is back.
  const second = call.openSocket();
  await once(second.ws, 'open');
  await waitFor(() => shape(second).includes('frame:phase'));
  assert.equal(call.registry.get('vs-1').ended, false, 're-attaching inside the window keeps the call');

  // What it missed, in the order it happened: the phase first, then every delta,
  // the turn's own end, the end of the speech, and every audio chunk.
  assert.deepEqual(shape(second), [
    'frame:ready',
    'frame:phase',
    'frame:phase',
    'frame:reply',
    'audio:1',
    'audio:2',
    'audio:3',
    'frame:reply',
    'frame:turn',
    'frame:speech',
    'frame:phase',
  ]);
  assert.deepEqual(
    second.frames().filter((frame) => frame.t === 'reply').map((frame) => frame.delta),
    ['Here is the answer. ', 'And the rest of it.'],
  );
  assert.equal(second.frames().find((frame) => frame.t === 'turn').state, 'done');
  assert.equal(second.frames().find((frame) => frame.t === 'speech').state, 'end');

  // A phone that never comes back still ends the call, at the whole window.
  await second.drop();
  await advanceClock(t, 91_000);
  assert.equal(call.registry.get('vs-1').ended, true);
  assert.equal(call.registry.get('vs-1').endedReason, 'network');
});

test('a replay log past its bound drops the oldest audio, keeps every control frame, and marks the gap once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const engine = makeControllableEngine();
  const { turn, runTurn } = controllableTurn();
  // 40 ms of speech at the output rate is two 20 ms chunks, so five chunks of a
  // reply cannot all fit.
  const call = await startCall({ engine, runTurn, maxBufferedAudioMs: 40 });
  t.after(() => call.close());

  engine.emit('final', { text: 'turn one' });
  await waitFor(() => turn.handlers);
  const gen = 1;
  await call.first.drop();
  await advanceClock(t, 5_000);

  turn.handlers.onDelta('First half. ');
  for (const byte of [1, 2, 3, 4, 5]) {
    engine.emit('speechAudio', { gen, pcm: Buffer.alloc(960, byte) });
  }
  turn.handlers.onDelta(' Second half.');
  await advanceClock(t, 5_000);
  turn.release({ hasContent: true });
  await new Promise((done) => setImmediate(done));
  engine.emit('speechDone', { gen });
  await advanceClock(t, 5_000);

  const second = call.openSocket();
  await once(second.ws, 'open');
  await waitFor(() => shape(second).includes('frame:phase'));

  // The head of the reply is what went: its tail is more useful than its start.
  // The deltas, the turn's end and the end of the speech are all still there.
  assert.deepEqual(shape(second), [
    'frame:ready',
    'frame:phase',
    'frame:phase',
    'frame:reply',
    'frame:speech',
    'audio:4',
    'audio:5',
    'frame:reply',
    'frame:turn',
    'frame:speech',
    'frame:phase',
  ]);
  const gaps = second.frames().filter((frame) => frame.t === 'speech' && frame.state === 'gap');
  assert.equal(gaps.length, 1, 'the gap is named once');
  const gapAt = second.entries.findIndex((entry) => entry.frame?.state === 'gap');
  const firstAudioAt = second.entries.findIndex((entry) => entry.binary);
  assert.equal(gapAt, firstAudioAt - 1, 'the gap is marked before the audio that follows it');
  assert.equal(second.frames().filter((frame) => frame.t === 'reply').length, 2, 'no delta was dropped');
  assert.equal(second.frames().find((frame) => frame.t === 'turn').state, 'done');
});

test('audio from a generation the call has cancelled is dropped, and the new generation plays', async (t) => {
  // The chunks already emitted for a reply the operator barged in over must not
  // keep playing over them; the reducer's generation is what says which is which.
  const engine = makeControllableEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall({ engine, runTurn });
  t.after(() => call.close());
  const first = call.first;

  engine.emit('final', { text: 'turn one' });
  await waitFor(() => turn.handlers);
  turn.handlers.onDelta('A long answer.');
  await waitFor(() => engine.spoken.length > 0);
  const speaking = engine.spoken[0].gen;
  engine.emit('speechAudio', { gen: speaking, pcm: Buffer.from([7, 7]) });
  await waitFor(() => first.entries.some((entry) => entry.binary));
  turn.release({ hasContent: true });
  await new Promise((done) => setImmediate(done));
  engine.emit('speechDone', { gen: speaking });

  engine.emit('final', { text: 'turn two' });
  await waitFor(() => turn.handlers && turn.text === 'turn two');
  turn.handlers.onDelta('A fresh answer.');
  await waitFor(() => engine.spoken.at(-1).gen === speaking + 1);
  engine.emit('speechAudio', { gen: speaking, pcm: Buffer.from([8, 8]) });
  await new Promise((done) => realSetTimeout(done, 30));
  assert.equal(
    first.entries.filter((entry) => entry.binary && entry.data[0] === 8).length,
    0,
    'the cancelled generation is not written to the phone',
  );
  engine.emit('speechAudio', { gen: speaking + 1, pcm: Buffer.from([9, 9]) });
  await waitFor(() => first.entries.some((entry) => entry.binary && entry.data[0] === 9));
});

test('a turn in flight when the phone is gone is parked to completion and its reply is pushed once', async (t) => {
  const engine = makeControllableEngine();
  const { turn, runTurn } = controllableTurn();
  const pushes = [];
  const audits = [];
  const lines = [];
  const call = await startCall({
    engine,
    runTurn,
    resumeTimeoutMs: 40,
    notifyPush: (event) => pushes.push(event),
    // The real writer: a field it does not list is dropped, and a hand-made sink
    // would hide exactly that.
    audit: (summary) => audits.push(buildAuditLine(summary)),
    log: (line) => lines.push(line),
  });
  t.after(() => call.close());

  engine.emit('final', { text: 'turn one' });
  await waitFor(() => turn.handlers);
  const spokenBefore = engine.spoken.length;
  await call.first.drop();
  await waitFor(() => call.registry.get('vs-1').ended === true);
  assert.equal(turn.aborted, false, 'the turn the phone walked away from is not thrown away');

  // It finishes with nobody there: the deltas are discarded rather than spoken
  // or buffered for a phone that will not re-attach.
  turn.handlers.onDelta('The answer that was owed. ');
  turn.release({ hasContent: true });
  await waitFor(() => pushes.length === 1);
  assert.equal(pushes[0].trigger, 'final-response');
  assert.equal(pushes[0].sessionId, 'sess-1');
  assert.equal(pushes[0].botId, 'scout');
  assert.equal(pushes[0].text, 'The answer that was owed.');
  await new Promise((done) => realSetTimeout(done, 30));
  assert.equal(pushes.length, 1, 'one completed turn is one notification');
  assert.equal(engine.spoken.length, spokenBefore, 'nothing was spoken to a socket that is not there');

  // The audit line says a turn was parked, in counts and names only.
  assert.equal(audits.length, 1);
  assert.equal(audits[0].parkedTurns, 1);
  assert.equal(audits[0].error, 'network');
  assert.equal(JSON.stringify(audits[0]).includes('turn one'), false, 'no text on the line');

  // The end line counts the same way: every field it names is a real number,
  // and the parked turn is one of them.
  const end = lines.find((line) => line.startsWith('voice.end '));
  assert.ok(end, lines.join('\n'));
  assert.equal(/NaN/.test(end), false, `every count on the end line is a count: ${end}`);
  assert.match(end, /finals=1 speechChunks=0 utterances=1/);
  assert.match(end, /turns=1 parkedTurns=1/);
});

test('a parked turn is aborted at parkedTurnMaxMs, and a hang-up aborts at once', async (t) => {
  const engine = makeControllableEngine();
  const { turn, runTurn } = controllableTurn();
  const lines = [];
  const call = await startCall({
    engine,
    runTurn,
    resumeTimeoutMs: 40,
    parkedTurnMaxMs: 60,
    log: (line) => lines.push(line),
  });
  t.after(() => call.close());

  engine.emit('final', { text: 'turn one' });
  await waitFor(() => turn.handlers);
  await call.first.drop();
  await waitFor(() => call.registry.get('vs-1').ended === true);
  await waitFor(() => turn.aborted === true);
  assert.ok(lines.some((line) => /voice\.turn parked timeout/.test(line)), lines.join('\n'));

  // A person who hangs up means it: the turn is not parked.
  const other = makeControllableEngine();
  const hungUp = controllableTurn();
  const second = await startCall({ engine: other, runTurn: hungUp.runTurn });
  t.after(() => second.close());
  other.emit('final', { text: 'turn one' });
  await waitFor(() => hungUp.turn.handlers);
  const closed = once(second.first.ws, 'close');
  second.first.ws.send(JSON.stringify({ t: 'end' }));
  await closed;
  assert.equal(hungUp.turn.aborted, true);
});

test('a registry end for a phone that is gone (abandoned, expired) parks the turn; a Gate restart does not', async (t) => {
  for (const reason of ['abandoned', 'expired']) {
    const engine = makeControllableEngine();
    const { turn, runTurn } = controllableTurn();
    const pushes = [];
    const call = await startCall({ engine, runTurn, parkedTurnMaxMs: 5_000, notifyPush: (event) => pushes.push(event) });
    t.after(() => call.close());
    engine.emit('final', { text: 'turn one' });
    await waitFor(() => turn.handlers);

    // The registry ends the call from the outside: a re-dial, or its own clock.
    call.registry.end('vs-1', reason);
    await waitFor(() => call.registry.get('vs-1').ended === true);
    await settle();
    assert.equal(turn.aborted, false, `${reason}: the turn the phone left behind is parked, not thrown away`);

    turn.handlers.onDelta('Owed. ');
    turn.release({ hasContent: true });
    await waitFor(() => pushes.length === 1);
    assert.equal(pushes[0].text, 'Owed.', `${reason}: the parked reply is delivered`);
  }
});

test('a Gate restart aborts the turn in flight rather than parking it', async (t) => {
  const engine = makeControllableEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall({ engine, runTurn });
  t.after(() => call.close());
  engine.emit('final', { text: 'turn one' });
  await waitFor(() => turn.handlers);
  call.endAll('gate-restart');
  await waitFor(() => turn.aborted === true);
  assert.equal(call.registry.get('vs-1').endedReason, 'gate-restart');
});
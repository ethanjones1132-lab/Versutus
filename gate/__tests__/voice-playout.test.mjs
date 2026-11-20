// Reply audio leaves the Gate at the pace it is heard. Without pacing,
// a rendered sentence reached the phone in a burst: a
// long sentence overran the phone's playback queue, the call said "listening"
// while the reply still had seconds to play, and the first sentence finishing
// synthesis ended the whole reply. These drive a real media socket with an
// engine the test controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { LocalEngine } from '../core/voice/engines/local-engine.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

const SESSION = {
  voiceSessionId: 'vs-1',
  deviceId: 'dev-1',
  engine: 'local',
  thread: { kind: 'configurable', sessionId: 'sess-1' },
};

// 24 kHz mono PCM16.
const BYTES_PER_MS = 48;
const pcm = (ms, value = 1) => Buffer.alloc(ms * BYTES_PER_MS, value);

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 5));
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function makeEngine({ reportsHearing = false } = {}) {
  const listeners = new Map();
  const engine = {
    id: 'local',
    reportsHearing,
    spoken: [],
    cancelled: [],
    playback: [],
    open: async () => {},
    pushAudio: () => {},
    close: async () => {},
    on: (event, fn) => {
      listeners.set(event, fn);
      return engine;
    },
    emit: (event, payload) => listeners.get(event)?.(payload),
    speak: (text, { gen } = {}) => {
      engine.spoken.push({ text, gen });
    },
    cancelSpeech: (gen) => {
      engine.cancelled.push(gen);
    },
    setMuted: () => {},
    setPlayback: (on) => {
      engine.playback.push(on);
    },
  };
  return engine;
}

function controllableTurn() {
  const turn = { handlers: null, texts: [] };
  const runTurn = (_session, text, handlers) => {
    turn.texts.push(text);
    turn.handlers = handlers;
    return new Promise((resolve, reject) => {
      turn.release = (result = { hasContent: true }) => resolve(result);
      turn.fail = (error) => reject(error);
      handlers.signal.addEventListener('abort', () => reject(new Error('turn aborted')));
    });
  };
  return { turn, runTurn };
}

async function startCall(t, { engine, runTurn, ...options } = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create({ ...SESSION });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const lines = [];
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async () => ({ deviceId: 'dev-1' }) },
    registry,
    createEngine: () => engine,
    runTurn,
    log: (line) => lines.push(line),
    utteranceHoldMs: 0,
    playoutLeadMs: 200,
    playoutTailMs: 40,
    ...options,
  });
  server.listen(0);
  await once(server, 'listening');
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-1&protocol=2`,
    { headers: { Authorization: 'Bearer tok-1' } },
  );
  const frames = [];
  const audio = [];
  ws.on('message', (data, binary) => {
    if (binary) audio.push({ at: Date.now(), bytes: data.length - 8, pcm: data.subarray(8) });
    else frames.push({ at: Date.now(), ...JSON.parse(data.toString()) });
  });
  await once(ws, 'open');
  await waitFor(() => frames.some((frame) => frame.t === 'phase' && frame.phase === 'listening'));
  t.after(async () => {
    registry.end('vs-1', 'test-cleanup');
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const heardMs = () => audio.reduce((sum, chunk) => sum + chunk.bytes, 0) / BYTES_PER_MS;
  const phases = () => frames.filter((frame) => frame.t === 'phase').map((frame) => frame.phase);
  const speech = () => frames.filter((frame) => frame.t === 'speech').map((frame) => frame.state);
  return { ws, frames, audio, lines, heardMs, phases, speech, registry };
}

/** Commit one spoken turn and wait until the test holds its handlers. */
async function openTurn(engine, turn, text = 'hello') {
  engine.emit('final', { text });
  await waitFor(() => turn.handlers);
}

test('chunked Kokoro PCM reaches the phone before the complete sentence returns', async (t) => {
  let notify;
  const jobs = [];
  const lease = {
    request: async () => ({ ok: true, ttsChunkWords: 8 }),
    onNotification: (handler) => { notify = handler; },
    send: (method, params) => { if (method === 'voice.speak') jobs.push(params); },
    release: () => {},
  };
  const engine = new LocalEngine({ pool: { lease: async () => lease } });
  const { turn, runTurn } = controllableTurn();
  const call = await startCall(t, { engine, runTurn, utteranceSettleMs: 0 });
  await openTurn(engine, turn);

  const text = 'I would start by trying the simplest option before changing anything else. Next sentence.';
  turn.handlers.onDelta(text);
  turn.release();
  await waitFor(() => jobs.length === 1);
  assert.equal(engine.ttsChunkWords, 8);
  assert.equal(jobs[0].text, text);
  assert.equal(jobs[0].splitOpening, true, 'the worker owns the cut for a complete opening sentence');

  const { gen, ttsId } = jobs[0];
  const sendPcm = (ms, timing = {}) => notify({
    method: 'voice.speechAudio',
    params: { gen, chunk: { data: pcm(ms).toString('base64') }, ...timing },
  });
  sendPcm(300, { ttsId, sentence: 1, queueMs: 0, synthMs: 75 });
  // The worker is not allowed to finish the sentence until a real WebSocket
  // client observes its opening phrase. Waiting for speechDone would deadlock.
  await waitFor(() => call.audio.length > 0);
  assert.equal(call.speech().includes('end'), false);
  assert.match(call.lines.find((line) => line.startsWith('voice.tts ')),
    /sentence=1 workerQueueMs=0 synthToPcmMs=75 effectToWorkerPcmMs=\d+ pcmToSendMs=\d+ effectToSendMs=\d+/);

  sendPcm(200); // continuation of sentence 1, not timed as a second sentence
  sendPcm(100, { ttsId, sentence: 2, queueMs: 95, synthMs: 25 });
  notify({ method: 'voice.speechDone', params: { gen, ttsId } });
  await waitFor(() => call.speech().includes('end'));
  assert.equal(call.heardMs(), 600);
  const timings = call.lines.filter((line) => line.startsWith('voice.tts '));
  assert.equal(timings.length, 2);
  assert.match(timings[1], /sentence=2 workerQueueMs=95 synthToPcmMs=25 .* pcmToSendMs=\d+/);
});

test('the local worker receives the prefix size only with the streamed continuation', async (t) => {
  const jobs = [];
  const lease = {
    request: async () => ({ ok: true, ttsChunkWords: 8 }),
    onNotification: () => {},
    send: (method, params) => { if (method === 'voice.speak') jobs.push(params); },
    release: () => {},
  };
  const engine = new LocalEngine({ pool: { lease: async () => lease } });
  const { turn, runTurn } = controllableTurn();
  await startCall(t, { engine, runTurn, utteranceSettleMs: 0 });
  await openTurn(engine, turn);

  const opening = 'I would start with the simplest option first, ';
  const tail = 'and then check whether the result matches what you expected.';
  turn.handlers.onDelta(opening);
  await waitFor(() => jobs.length === 1);
  turn.handlers.onDelta(tail);
  turn.release();
  await waitFor(() => jobs.length === 2);
  assert.deepEqual(jobs.map(({ text, splitOpening, openingPrefixWords }) => [text, splitOpening, openingPrefixWords]), [
    [opening, false, undefined],
    [tail, false, 8],
  ]);
});

test('the next sentence is submitted during playout and a late sentence does not send padding', async (t) => {
  const engine = makeEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall(t, { engine, runTurn, playoutLeadMs: 60 });
  await openTurn(engine, turn);

  turn.handlers.onDelta('The first sentence. ');
  await waitFor(() => engine.spoken.length === 1);
  const { gen } = engine.spoken[0];
  const first = pcm(700);
  const second = pcm(100, 2);
  const late = pcm(100, 3);
  engine.emit('speechAudio', { gen, pcm: first });
  engine.emit('speechDone', { gen });
  await waitFor(() => call.audio.length > 0);

  turn.handlers.onDelta('The second sentence. ');
  await waitFor(() => engine.spoken.length === 2);
  assert.ok(call.heardMs() < 700, 'sentence two starts before sentence one has even finished sending');
  engine.emit('speechAudio', { gen, pcm: second });
  engine.emit('speechDone', { gen });

  turn.handlers.onDelta('The late sentence.');
  turn.release();
  await waitFor(() => engine.spoken.length === 3);
  await waitFor(() => call.heardMs() >= 800);
  await sleep(200); // exhaust the pacer's 60 ms lead plus one 100 ms frame
  assert.equal(call.heardMs(), 800, 'no audio is sent to pad the underrun');
  engine.emit('speechAudio', { gen, pcm: late });
  engine.emit('speechDone', { gen });
  await waitFor(() => call.speech().includes('end'));
  assert.deepEqual(Buffer.concat(call.audio.map((chunk) => chunk.pcm)), Buffer.concat([first, second, late]));
});

test('a reply is not over when its first sentence has been synthesised', async (t) => {
  const engine = makeEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall(t, { engine, runTurn });
  await openTurn(engine, turn);

  turn.handlers.onDelta('The first sentence. ');
  await waitFor(() => engine.spoken.length === 1);
  const gen = engine.spoken[0].gen;
  engine.emit('speechAudio', { gen, pcm: pcm(100) });
  // The worker reports each sentence as it finishes it, long before the model
  // has finished writing the reply.
  engine.emit('speechDone', { gen });
  await sleep(150);
  assert.equal(call.phases().at(-1), 'speaking', 'the reply is still being written');
  assert.equal(call.speech().includes('end'), false);

  turn.handlers.onDelta('And the second one.');
  turn.release();
  await waitFor(() => engine.spoken.length === 2);
  assert.deepEqual(engine.spoken.map((entry) => entry.text), ['The first sentence. ', 'And the second one.']);
  assert.equal(engine.spoken[1].gen, gen, 'the rest of the reply is the same generation');
  // No part of the reply was dropped on the way to the phone either.
  await waitFor(() => call.frames.filter((frame) => frame.t === 'reply').length === 2);

  engine.emit('speechAudio', { gen, pcm: pcm(100) });
  engine.emit('speechDone', { gen });
  await waitFor(() => call.phases().at(-1) === 'listening');
  assert.deepEqual(call.speech(), ['start', 'end']);
  assert.equal(call.heardMs(), 200);
});

test('reply audio is sent no further ahead of the phone than the lead', async (t) => {
  const engine = makeEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall(t, { engine, runTurn });
  await openTurn(engine, turn);
  turn.handlers.onDelta('A long sentence.');
  turn.release();
  await waitFor(() => engine.spoken.length === 1);
  const gen = engine.spoken[0].gen;

  // Two seconds of speech arrive from the synthesiser in one piece.
  const sentAt = Date.now();
  engine.emit('speechAudio', { gen, pcm: pcm(2_000) });
  engine.emit('speechDone', { gen });
  await sleep(120);
  // 200 ms of lead, one 100 ms chunk of slack, and the 120 ms that has passed.
  assert.ok(call.heardMs() >= 200, `the lead is sent at once, got ${call.heardMs()} ms`);
  assert.ok(call.heardMs() <= 500, `only the lead is ahead of the phone, got ${call.heardMs()} ms`);
  assert.equal(call.phases().at(-1), 'speaking');

  await waitFor(() => call.phases().at(-1) === 'listening', 5_000);
  assert.equal(call.heardMs(), 2_000, 'every chunk was sent, in the end');
  const ended = call.frames.find((frame) => frame.t === 'speech' && frame.state === 'end');
  // Speaking lasted as long as the reply was audible, not as long as it took
  // to synthesise.
  assert.ok(ended.at - sentAt >= 1_900, `speech ended after ${ended.at - sentAt} ms`);
  for (const chunk of call.audio) assert.ok(chunk.bytes <= 100 * BYTES_PER_MS);
});

test('the engine is told when the loudspeaker goes live and when it goes quiet', async (t) => {
  const engine = makeEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall(t, { engine, runTurn });
  await openTurn(engine, turn);
  turn.handlers.onDelta('Hello there.');
  turn.release();
  await waitFor(() => engine.spoken.length === 1);
  const gen = engine.spoken[0].gen;
  assert.deepEqual(engine.playback, [], 'nothing is playing before the first chunk leaves');

  engine.emit('speechAudio', { gen, pcm: pcm(300) });
  assert.deepEqual(engine.playback, [true]);
  // Synthesis is over; the phone has most of it still to play.
  engine.emit('speechDone', { gen });
  await sleep(100);
  assert.deepEqual(engine.playback, [true], 'the echo gate stays up while the reply is audible');

  await waitFor(() => call.phases().at(-1) === 'listening');
  assert.deepEqual(engine.playback, [true, false]);
});

test('a barge-in throws away what was queued instead of playing it out', async (t) => {
  const engine = makeEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall(t, { engine, runTurn });
  await openTurn(engine, turn);
  turn.handlers.onDelta('A very long answer.');
  await waitFor(() => engine.spoken.length === 1);
  const gen = engine.spoken[0].gen;

  engine.emit('speechAudio', { gen, pcm: pcm(3_000) });
  await sleep(60);
  engine.emit('userSpeechStart', { gen });
  await waitFor(() => call.speech().includes('cancelled'));
  const heardAtCancel = call.heardMs();
  assert.ok(heardAtCancel <= 500, `at most the lead was ahead of the phone, got ${heardAtCancel} ms`);
  assert.deepEqual(engine.cancelled, [gen]);
  assert.equal(engine.playback.at(-1), false, 'the echo gate drops with the speech');

  await sleep(400);
  assert.equal(call.heardMs(), heardAtCancel, 'nothing of the cancelled reply is sent afterwards');
  assert.equal(call.phases().at(-1), 'listening');
  assert.equal(call.speech().includes('end'), false, 'a cancelled reply is not reported as finished');
});

test('a reply whose synthesis never reports back stops being "speaking" at the stall bound', async (t) => {
  const engine = makeEngine();
  const { turn, runTurn } = controllableTurn();
  const call = await startCall(t, { engine, runTurn, playoutStallMs: 120 });
  await openTurn(engine, turn);
  turn.handlers.onDelta('Hello there.');
  turn.release();
  await waitFor(() => engine.spoken.length === 1);

  // The worker died mid-sentence: no audio, no speechDone.
  await waitFor(() => call.phases().includes('speaking'));
  await waitFor(() => call.phases().at(-1) === 'listening', 2_000);
  assert.ok(call.lines.some((line) => /^voice\.speech stalled /.test(line)), 'and the log says why');

  // It was only slow, not dead: the engine is told to stop, and the sentence it
  // finishes anyway is not played into a call that has moved on.
  const gen = engine.spoken[0].gen;
  assert.deepEqual(engine.cancelled, [gen]);
  engine.emit('speechAudio', { gen, pcm: pcm(400) });
  engine.emit('speechDone', { gen });
  await sleep(150);
  assert.equal(call.heardMs(), 0, 'nothing of the abandoned reply reaches the phone');
  assert.equal(call.phases().at(-1), 'listening');
});

// ─── Turn-taking with an engine that says when the person has stopped ──────

test('a turn is not sent while the engine is still hearing the person, and is sent a settle after', async (t) => {
  const engine = makeEngine({ reportsHearing: true });
  const { turn, runTurn } = controllableTurn();
  const call = await startCall(t, { engine, runTurn, utteranceHoldMs: 5_000, utteranceSettleMs: 40 });

  engine.emit('hearing', { active: true });
  engine.emit('final', { text: 'First sentence.' });
  await sleep(200);
  assert.equal(turn.texts.length, 0, 'the person is still talking');
  assert.equal(call.phases().at(-1), 'listening');

  engine.emit('final', { text: 'Second sentence.' });
  engine.emit('hearing', { active: false });
  await waitFor(() => turn.texts.length === 1, 1_000);
  // Far inside the 5 s hold an engine without the signal would have waited.
  assert.deepEqual(turn.texts, ['First sentence. Second sentence.']);
});

test('an engine that reports hearing gets no speculative turn on an early end', async (t) => {
  const engine = makeEngine({ reportsHearing: true });
  const { turn, runTurn } = controllableTurn();
  await startCall(t, { engine, runTurn, utteranceSettleMs: 40 });

  engine.emit('hearing', { active: true });
  engine.emit('earlyEnd', { text: 'Half a thought' });
  await sleep(100);
  assert.equal(turn.texts.length, 0, 'nothing reaches the Bot before the turn is committed');

  engine.emit('final', { text: 'Half a thought' });
  engine.emit('hearing', { active: false });
  await waitFor(() => turn.texts.length === 1, 1_000);
  assert.deepEqual(turn.texts, ['Half a thought'], 'and the Bot is asked exactly once');
});

// ─── What a failed turn is called on the phone ─────────────────────────────

test('a failed turn is named by who failed, never in the backend\'s own words', async (t) => {
  const engine = makeEngine();
  const runTurn = async (_session, _text, handlers) => {
    handlers.onStage({ stage: 'resolve.ready', backend: 'claude-code' });
    throw new Error('claude-code exited with code 1: the prompt was "my account number is 4417"');
  };
  const call = await startCall(t, { engine, runTurn });

  engine.emit('final', { text: 'hello' });
  const failed = await waitFor(() => call.frames.find((frame) => frame.t === 'turn' && frame.state === 'failed'));
  assert.equal(failed.error, 'Claude Code stopped before it answered.');
  assert.equal(JSON.stringify(call.frames).includes('4417'), false);
  const line = call.lines.find((entry) => /^voice\.turn fail /.test(entry));
  assert.match(line, /code=backend_exited/);
  assert.equal(line.includes('4417'), false);
});

// VS-127: a CLI that is signed out or spent is told on a call in one sentence
// naming the backend and its one fix. The CLI's own words stay on the host log
// (and the code there is the machine-readable one), never in what the call says.
test('a signed-out backend is told to the call with the one fix for that backend', async (t) => {
  const engine = makeEngine();
  const runTurn = async (_session, _text, handlers) => {
    handlers.onStage({ stage: 'resolve.ready', backend: 'claude-code' });
    throw new Error('claude-code: OAuth token has been revoked');
  };
  const call = await startCall(t, { engine, runTurn });

  engine.emit('final', { text: 'hello' });
  const failed = await waitFor(() => call.frames.find((frame) => frame.t === 'turn' && frame.state === 'failed'));
  assert.equal(
    failed.error,
    'Claude Code on your PC is signed out. Open a terminal on the PC, run `claude`, and sign in.',
  );
  assert.equal(JSON.stringify(call.frames).includes('OAuth'), false, 'the CLI\'s words never cross the wire');
  const line = call.lines.find((entry) => /^voice\.turn fail /.test(entry));
  assert.match(line, /code=backend_signed_out/);
});

test('an OpenCode with no provider credential is told to the call to run `opencode auth login`', async (t) => {
  const engine = makeEngine();
  const runTurn = async (_session, _text, handlers) => {
    handlers.onStage({ stage: 'resolve.ready', backend: 'opencode' });
    throw new Error('opencode: no provider credential is configured for this model');
  };
  const call = await startCall(t, { engine, runTurn });

  engine.emit('final', { text: 'hello' });
  const failed = await waitFor(() => call.frames.find((frame) => frame.t === 'turn' && frame.state === 'failed'));
  assert.equal(
    failed.error,
    'OpenCode on your PC is signed out. Open a terminal on the PC, run `opencode auth login`, and sign in.',
  );
  assert.equal(JSON.stringify(call.frames).includes('provider credential'), false, 'the CLI\'s words never cross the wire');
  const line = call.lines.find((entry) => /^voice\.turn fail /.test(entry));
  assert.match(line, /code=backend_signed_out/);
});

test('a spent plan is told to the call with the reset the CLI reported', async (t) => {
  const engine = makeEngine();
  const runTurn = async (_session, _text, handlers) => {
    handlers.onStage({ stage: 'resolve.ready', backend: 'codex' });
    throw new Error("codex: You've hit your usage limit. Resets at 14:00.");
  };
  const call = await startCall(t, { engine, runTurn });

  engine.emit('final', { text: 'hello' });
  const failed = await waitFor(() => call.frames.find((frame) => frame.t === 'turn' && frame.state === 'failed'));
  assert.equal(
    failed.error,
    "Codex has used up its plan's limit. It resets at 14:00; until then pick another backend.",
  );
  assert.equal(JSON.stringify(call.frames).includes('usage limit'), false);
  const line = call.lines.find((entry) => /^voice\.turn fail /.test(entry));
  assert.match(line, /code=backend_quota/);
});

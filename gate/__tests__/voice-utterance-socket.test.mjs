import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

const SESSION = { voiceSessionId: 'vs-1', deviceId: 'dev-1', engine: 'local' };

// The measured call: one person, seven segments, one question. The hold is a
// fraction of a second here so a test can play the pauses for real; the clock
// is injected so the latencies the audit reports are exact.
const SEGMENTS = [
  'what is the',
  'weather like',
  'in glasgow',
  'tomorrow morning',
  'and should i',
  'bring an umbrella',
  'thank you',
];
const UTTERANCE = SEGMENTS.join(' ');
/** The recognizer's running text for a segment, before its final completes it. */
const running = (segment) => segment.split(' ').slice(0, -1).join(' ');
/** Every partial frame the phone sees while the utterance is being gathered. */
function transcript() {
  const frames = [];
  const said = [];
  for (const segment of SEGMENTS) {
    frames.push([...said, running(segment)].join(' ').trim());
    said.push(segment);
    frames.push(said.join(' '));
  }
  return frames;
}

/** A controllable engine: the test decides when speech starts and ends, and what a final says. */
function makeControllableEngine() {
  const listeners = new Map();
  const engine = {
    open: async () => {},
    pushAudio: () => {},
    close: async () => {},
    spoken: [],
    cancelled: [],
    muted: false,
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
    setMuted: (muted) => {
      engine.muted = muted;
    },
  };
  return engine;
}

async function startCall({
  engine,
  runTurn,
  utteranceHoldMs = 150,
  continuationMs = 4_000,
  speculationWindowMs,
} = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create(SESSION);
  const deviceTokens = {
    verify: async (authorization) => (String(authorization) === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const clock = { at: 1_000 };
  const audit = [];
  const lines = [];
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => engine,
    runTurn,
    audit: (summary) => audit.push(summary),
    log: (line) => lines.push(line),
    utteranceHoldMs,
    continuationMs,
    ...(speculationWindowMs === undefined ? {} : { speculationWindowMs }),
    now: () => clock.at,
  });
  server.listen(0);
  await once(server, 'listening');
  const frames = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-1`,
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
    advance: (ms) => {
      clock.at += ms;
    },
    end: async () => {
      const closed = once(ws, 'close');
      ws.send(JSON.stringify({ t: 'end' }));
      await waitUntil(() => audit.length === 1);
      await closed;
    },
    close: () =>
      new Promise((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(done));
      }),
  };
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

const ofType = (frames, t) => frames.filter((frame) => frame.t === t);
const logged = (lines, pattern) => lines.filter((line) => pattern.test(line));

test('the measured call is one utterance, and the call log accounts for every final', async () => {
  const engine = makeControllableEngine();
  const turns = [];
  const call = await startCall({
    engine,
    runTurn: async (_session, text, handlers) => {
      turns.push(text);
      handlers.onDelta('It will rain in Glasgow.');
      return { hasContent: true };
    },
  });

  // Seven finals, each inside the hold of the one before it: one person saying
  // one long thing, which is what the log recorded as seven dropped turns. Each
  // segment is heard the way the recognizer hears it — running text first, the
  // final that completes it a moment later.
  for (const segment of SEGMENTS) {
    call.advance(200);
    engine.emit('partial', { text: running(segment) });
    engine.emit('final', { text: segment });
    await sleep(30);
  }
  await waitUntil(() => turns.length === 1);
  await waitUntil(() => ofType(call.frames, 'reply').length === 1);
  call.advance(800);

  assert.deepEqual(turns, [UTTERANCE], 'one turn carries all seven sentences');
  const finalFrames = ofType(call.frames, 'final');
  assert.equal(finalFrames.length, 1);
  assert.equal(finalFrames[0].text, UTTERANCE);
  assert.deepEqual(
    ofType(call.frames, 'phase').map((frame) => frame.phase),
    ['listening', 'thinking', 'speaking'],
    'one turn, so one thinking phase',
  );
  // The phone watched the utterance grow rather than seeing one frame per sentence.
  const partials = ofType(call.frames, 'partial').map((frame) => frame.text);
  assert.deepEqual(partials, transcript(), 'the live transcript grew as each segment was heard');

  await call.end();
  assert.deepEqual(
    {
      finals: call.audit[0].finals,
      utterances: call.audit[0].utterances,
      queued: call.audit[0].queued,
      continued: call.audit[0].continued,
      turns: call.audit[0].turns,
      partials: call.audit[0].partials,
    },
    { finals: 7, utterances: 1, queued: 0, continued: 0, turns: 1, partials: 14 },
  );
  assert.equal(
    logged(call.lines, /^voice\.utterance commit /).length,
    1,
    'one utterance was committed',
  );
  assert.match(
    logged(call.lines, /^voice\.utterance commit /)[0],
    new RegExp(`chars=${UTTERANCE.length} finals=7`),
  );
  assert.equal(logged(call.lines, /^voice\.final queued /).length, 0);
  assert.equal(logged(call.lines, /^voice\.final duplicate /).length, 0);
  assert.match(logged(call.lines, /^voice\.end /)[0], /finals=7 .*utterances=1 queued=0 continued=0 turns=1/);
  await call.close();
});

test('finals heard while the reply is spoken wait for one follow-up turn, not one each', async () => {
  const engine = makeControllableEngine();
  const turns = [];
  const call = await startCall({
    engine,
    utteranceHoldMs: 60,
    runTurn: async (_session, text, handlers) => {
      turns.push(text);
      handlers.onDelta('Tell me more.');
      return { hasContent: true };
    },
  });

  engine.emit('final', { text: 'first question' });
  await waitUntil(() => turns.length === 1);
  await waitUntil(() => ofType(call.frames, 'phase').some((frame) => frame.phase === 'speaking'));
  const spokenGen = engine.spoken[0].gen;

  // The person keeps talking over the answer.
  for (const text of ['second question', 'and a third']) {
    call.advance(300);
    engine.emit('partial', { text });
    engine.emit('final', { text });
  }
  await sleep(30);
  assert.deepEqual(turns, ['first question'], 'the answer is not interrupted');

  engine.emit('speechDone', { gen: spokenGen });
  await waitUntil(() => turns.length === 2);
  call.advance(800);
  assert.deepEqual(turns, ['first question', 'second question and a third']);

  await call.end();
  assert.deepEqual(
    {
      finals: call.audit[0].finals,
      utterances: call.audit[0].utterances,
      queued: call.audit[0].queued,
      turns: call.audit[0].turns,
    },
    { finals: 3, utterances: 2, queued: 2, turns: 2 },
  );
  assert.equal(logged(call.lines, /^voice\.final queued /).length, 2);
  assert.deepEqual(
    logged(call.lines, /^voice\.utterance commit /).map((line) => /finals=(\d+)/.exec(line)[1]),
    ['1', '2'],
    'the follow-up turn was one utterance of the two segments that waited',
  );
  await call.close();
});

test('a final heard while the turn is still thinking is folded into that turn', async () => {
  const engine = makeControllableEngine();
  const attempts = [];
  let firstAborted = false;
  const call = await startCall({
    engine,
    utteranceHoldMs: 60,
    runTurn: (_session, text, handlers) => {
      attempts.push(text);
      return new Promise((_resolve, reject) => {
        handlers.signal.addEventListener('abort', () => {
          firstAborted = true;
          reject(new Error('aborted'));
        });
      });
    },
  });

  engine.emit('final', { text: 'what is the' });
  await waitUntil(() => attempts.length === 1);
  call.advance(2_000);
  engine.emit('final', { text: 'weather in glasgow' });
  await waitUntil(() => attempts.length === 2);
  call.advance(500);

  assert.ok(firstAborted, 'the unanswered turn was cancelled, not left running');
  assert.deepEqual(attempts, ['what is the', 'what is the weather in glasgow']);
  assert.deepEqual(ofType(call.frames, 'final').map((frame) => frame.text), [
    'what is the',
    'what is the weather in glasgow',
  ]);

  await call.end();
  assert.deepEqual(
    { finals: call.audit[0].finals, continued: call.audit[0].continued, queued: call.audit[0].queued },
    { finals: 2, continued: 1, queued: 0 },
  );
  assert.equal(logged(call.lines, /^voice\.final merged /).length, 1);
  await call.close();
});

test('a second segment ends a speculative turn, and the hold starts the only live one', async () => {
  const engine = makeControllableEngine();
  const attempts = [];
  let draftAborted = false;
  const call = await startCall({
    engine,
    utteranceHoldMs: 60,
    // Long enough that the lost-frame net cannot interfere with this scenario.
    speculationWindowMs: 30_000,
    runTurn: (_session, text, handlers) => {
      attempts.push(text);
      return new Promise((_resolve, reject) => {
        handlers.signal.addEventListener('abort', () => {
          if (text === 'draft') draftAborted = true;
          reject(new Error('aborted'));
        });
      });
    },
  });

  // The engine was confident enough to name the turn early; the backend is
  // already answering the first segment.
  engine.emit('earlyEnd', { text: 'draft' });
  await waitUntil(() => attempts.length === 1);
  engine.emit('final', { text: 'draft' });
  await sleep(20);
  assert.deepEqual(attempts, ['draft'], 'the first segment alone commits nothing while a hold is open');

  engine.emit('final', { text: 'that was only half' });
  await waitUntil(() => attempts.length === 2);
  call.advance(400);

  assert.ok(draftAborted, 'the speculative upstream was ended as soon as the segment merged');
  assert.deepEqual(attempts, ['draft', 'draft that was only half']);
  assert.deepEqual(ofType(call.frames, 'final').map((frame) => frame.text), ['draft that was only half']);
  assert.deepEqual(
    ofType(call.frames, 'phase').map((frame) => frame.phase),
    ['listening', 'thinking'],
    'exactly one turn for one utterance',
  );

  await call.end();
  assert.equal(call.audit[0].turns, 1, 'the aborted guess never became a turn');
  assert.deepEqual(
    { finals: call.audit[0].finals, utterances: call.audit[0].utterances },
    { finals: 2, utterances: 1 },
  );
  await call.close();
});

test('the audit reports how long a turn took to answer and to be heard', async () => {
  const engine = makeControllableEngine();
  const call = await startCall({
    engine,
    utteranceHoldMs: 60,
    runTurn: async (_session, _text, handlers) => {
      call.advance(700);
      handlers.onDelta('Here is the answer.');
      return { hasContent: true };
    },
  });

  engine.emit('final', { text: 'what is the weather' });
  await waitUntil(() => ofType(call.frames, 'phase').some((frame) => frame.phase === 'speaking'));
  call.advance(50);
  engine.emit('speechAudio', { gen: engine.spoken[0].gen, pcm: Buffer.from([1, 2]) });
  engine.emit('speechDone', { gen: engine.spoken[0].gen });
  await waitUntil(() => call.frames.some((frame) => frame.t === 'phase' && frame.phase === 'listening'));

  await call.end();
  assert.equal(call.audit[0].p50FirstReplyMs, 700, 'commit to the first reply delta');
  assert.equal(call.audit[0].p50FirstAudioMs, 750, 'commit to the first speech chunk');
  await call.close();
});

test('a call with no turn records no latency at all', async () => {
  const call = await startCall({ engine: makeControllableEngine(), runTurn: async () => ({ hasContent: true }) });
  await call.end();
  assert.equal(call.audit[0].p50FirstAudioMs, null);
  assert.equal(call.audit[0].p50FirstReplyMs, null);
  assert.equal(call.audit[0].turns, 0);
  assert.equal(call.audit[0].utterances, 0);
  await call.close();
});

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

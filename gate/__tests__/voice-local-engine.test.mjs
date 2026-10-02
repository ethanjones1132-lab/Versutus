// The local engine is a lease on a shared worker, so these tests drive a fake
// worker process that loads when it is told to. What each one proves is in its
// name; the two the previous file pinned — that `open` returned once the
// process was spawned, and that `close` killed it — are the ones this file now
// pins the other way round (VOE-1, VOE-3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { LocalEngine } from '../core/voice/engines/local-engine.mjs';

class FakeChild extends EventEmitter {
  constructor(record) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.writable = true;
    stdin.write = (line) => record.push(JSON.parse(line));
    stdin.end = () => {};
    this.stdin = stdin;
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function harness({
  backoffMs = [10],
  maxRestarts = 5,
  engineOpenTimeoutMs = 5_000,
  commandQueueLimit,
} = {}) {
  const children = [];
  const scheduled = [];
  const lines = [];
  const engine = new LocalEngine({
    paths: { python: 'python', models: 'models', worker: 'worker' },
    spawn: () => {
      const record = [];
      const child = new FakeChild(record);
      child.record = record;
      children.push(child);
      return child;
    },
    backoffMs,
    maxRestarts,
    engineOpenTimeoutMs,
    ...(commandQueueLimit === undefined ? {} : { commandQueueLimit }),
    schedule: (fn, ms) => {
      const handle = { fn, ms, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    log: (line) => lines.push(typeof line === 'string' ? line : String(line?.message ?? line)),
  });
  return { engine, children, scheduled, lines };
}

function notify(child, method, params) {
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

/** Answer every request the worker has been sent, oldest first. */
function answer(child, result = { ok: true }) {
  for (const message of child.record) {
    if (message.id === undefined || message.answered) continue;
    message.answered = true;
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  }
}

function load(child, params = { sampleRate: { input: 16000, output: 24000 }, device: 'cuda', loadMs: 18_400 }) {
  notify(child, 'voice.ready', params);
}

function due(scheduled, ms) {
  return scheduled.filter((handle) => !handle.cancelled && handle.ms === ms).at(-1);
}

function fire(handle) {
  handle.cancelled = false;
  handle.fn();
}

function sent(child, method) {
  return child.record.filter((message) => message.method === method);
}

const tick = () => new Promise((done) => setImmediate(done));

/** Open a call and let the worker load and acknowledge it. */
async function opened(options) {
  const h = harness(options);
  let done = false;
  const pending = h.engine.open({ voiceSessionId: 'vs-1', botName: 'Scout' }).then(() => { done = true; });
  await tick();
  load(h.children[0]);
  await tick();
  answer(h.children[0]);
  await pending;
  assert.equal(done, true);
  return h;
}

/** Kill the worker, wait out the backoff and let the replacement load. */
async function restarted(h, { load: doLoad = true, answerOpen = true } = {}) {
  h.children.at(-1).emit('exit', 1);
  fire(due(h.scheduled, 10));
  const child = h.children.at(-1);
  if (doLoad) {
    load(child);
    await tick();
    if (answerOpen) answer(child);
  }
  await tick();
  return child;
}

test('open waits for the models, then tells the worker which session it serves', async () => {
  const h = harness();
  let done = false;
  const pending = h.engine.open({ voiceSessionId: 'vs-1', botName: 'Scout' }).then(() => { done = true; });
  await tick();

  assert.equal(h.children.length, 1, 'the worker is spawned');
  assert.equal(sent(h.children[0], 'voice.open').length, 0, 'a worker with no models is not opened yet');

  load(h.children[0]);
  await tick();
  assert.equal(done, false, 'the call is not open until voice.open is acknowledged');

  const opened = sent(h.children[0], 'voice.open');
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].params, { voiceSessionId: 'vs-1', botName: 'Scout' });

  answer(h.children[0]);
  await pending;
  assert.equal(done, true);
});

test('a pushed 20 ms frame becomes a 16 kHz mono base64 chunk', async () => {
  const { engine, children } = await opened();
  const frame = Buffer.alloc(640, 7);
  engine.pushAudio(frame);
  const pushed = sent(children[0], 'voice.pushAudio');
  assert.equal(pushed.at(-1).params.chunk.data, frame.toString('base64'));
  assert.equal(pushed.at(-1).params.chunk.sampleRate, 16000);
  assert.equal(pushed.at(-1).params.chunk.numChannels, 1);
});

test('worker notifications become engine events', async () => {
  const { engine, children } = await opened();

  const finals = [];
  const speech = [];
  engine.on('final', (event) => finals.push(event.text));
  engine.on('speechAudio', (event) => speech.push(event));

  notify(children[0], 'voice.final', { text: 'hello' });
  const pcm = Buffer.from([1, 2, 3, 4]);
  notify(children[0], 'voice.speechAudio', { gen: 2, chunk: { data: pcm.toString('base64'), sampleRate: 24000, numChannels: 1 } });

  assert.deepEqual(finals, ['hello']);
  assert.equal(speech.length, 1);
  assert.equal(speech[0].gen, 2);
  assert.deepEqual(speech[0].pcm, pcm);
});

test('a userSpeechStart notification becomes an engine userSpeechStart', async () => {
  const { engine, children } = await opened();

  const started = [];
  engine.on('userSpeechStart', (event) => started.push(event));
  notify(children[0], 'voice.userSpeechStart', { gen: 3 });

  assert.equal(started.length, 1);
  assert.equal(started[0].gen, 3);
});

test('an earlyEnd notification becomes an engine earlyEnd', async () => {
  const { engine, children } = await opened();

  const ends = [];
  engine.on('earlyEnd', (event) => ends.push(event));
  notify(children[0], 'voice.earlyEnd', { text: 'hello' });

  assert.equal(ends.length, 1);
  assert.equal(ends[0].text, 'hello');
});

test('a worker error notification becomes an engine error', async () => {
  const { engine, children } = await opened();
  const errors = [];
  engine.on('error', (event) => errors.push(event));

  notify(children[0], 'voice.error', { code: 'handler_failed', message: 'whisper gave up', fatal: false, gen: 7 });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'handler_failed');
  assert.equal(errors[0].fatal, false);
});

test('close releases the lease and leaves the shared worker running', async () => {
  const h = await opened();
  await h.engine.close();

  assert.ok(sent(h.children[0], 'voice.close').length === 1, 'the worker is told the call ended');
  assert.equal(h.children[0].killed, false, 'the next call reuses this process');

  const before = h.scheduled.length;
  h.children[0].emit('exit', 0);
  assert.equal(h.scheduled.length, before, 'a released worker is not restarted behind the Gate');
});

test('a dead worker is respawned on backoff and the call is opened on it', async () => {
  const h = await opened();
  const child = await restarted(h);

  assert.equal(h.children.length, 2);
  const reopened = sent(child, 'voice.open');
  assert.equal(reopened.length, 1);
  assert.deepEqual(reopened[0].params, { voiceSessionId: 'vs-1', botName: 'Scout' });
});

test('a restarted worker that never comes back is not fatal to the call', async () => {
  const h = await opened();
  const errors = [];
  h.engine.on('error', (event) => errors.push(event));

  await restarted(h, { load: false, answerOpen: false });

  assert.equal(errors.length, 0, 'a restart that has not finished yet is not an error');
});

test('speak, cancel and mute issued during a restart are replayed in order after it', async () => {
  const h = await opened();
  assert.equal(h.engine.speak('said first', { gen: 1 }), true, 'a ready worker is spoken to at once');

  h.children[0].emit('exit', 1);
  fire(due(h.scheduled, 10));
  const child = h.children[1];
  assert.equal(child.record.length, 0, 'nothing is written to a worker that is not there');

  assert.equal(h.engine.speak('said second', { gen: 1 }), false, 'a speak it cannot honour says so');
  h.engine.cancelSpeech(1);
  h.engine.speak('said third', { gen: 2 });
  h.engine.setMuted(true);
  assert.equal(child.record.length, 0, 'nothing is queued into a pipe nobody reads');

  load(child);
  await tick();
  assert.equal(child.record.length, 1, 'the new worker is opened first, and the queue waits for the ack');
  answer(child);
  await tick();

  assert.deepEqual(
    child.record.map((message) => [message.method, message.params?.text ?? message.params?.gen ?? message.params?.muted]),
    [
      ['voice.open', undefined],
      ['voice.speak', 'said second'],
      ['voice.cancelSpeech', 1],
      ['voice.speak', 'said third'],
      ['voice.setMuted', true],
    ],
  );
});

test('audio during a restart is dropped, and flows again once the call is reopened', async () => {
  const h = await opened();
  h.children[0].emit('exit', 1);
  fire(due(h.scheduled, 10));
  const child = h.children[1];

  const lost = Buffer.alloc(640, 3);
  h.engine.pushAudio(lost);
  assert.equal(sent(child, 'voice.pushAudio').length, 0, 'stale microphone audio is not replayed');

  load(child);
  await tick();
  answer(child);
  await tick();

  const heard = Buffer.alloc(640, 4);
  h.engine.pushAudio(heard);
  assert.equal(sent(child, 'voice.pushAudio').at(-1).params.chunk.data, heard.toString('base64'));
});

test('past the queue bound the oldest unsaid sentence is dropped and named', async () => {
  const h = await opened({ commandQueueLimit: 4 });
  h.children[0].emit('exit', 1);
  fire(due(h.scheduled, 10));
  const child = h.children[1];

  h.engine.speak('aaaa');
  h.engine.speak('bbbbb');
  h.engine.speak('ccccc');
  h.engine.setMuted(true);
  h.engine.speak('ddddd');
  h.engine.speak('eeeeee');
  assert.deepEqual(
    h.lines.filter((line) => line.includes('queue dropped')),
    ['voice.engine queue dropped kind=speak chars=4', 'voice.engine queue dropped kind=speak chars=5'],
  );
  assert.equal(
    h.lines.filter((line) => line.startsWith('voice.engine open')).length,
    1,
    'nothing is dropped, and so nothing is logged, inside the bound',
  );

  load(child);
  await tick();
  answer(child);
  await tick();

  assert.deepEqual(sent(child, 'voice.speak').map((message) => message.params.text), ['ccccc', 'ddddd', 'eeeeee']);
  assert.deepEqual(sent(child, 'voice.setMuted').map((message) => message.params.muted), [true]);
});

test('a spent restart budget ends the call with a fatal engine_failed', async () => {
  const h = await opened({ maxRestarts: 1 });
  const errors = [];
  h.engine.on('error', (event) => errors.push(event));

  await restarted(h, { load: false, answerOpen: false });
  h.children[1].emit('exit', 1);

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'engine_failed');
  assert.equal(errors[0].fatal, true, 'the call ends with a reason instead of sitting deaf');
});

test('open gives up with a named error when the worker cannot warm in time', async () => {
  const h = harness({ engineOpenTimeoutMs: 30 });
  await assert.rejects(
    () => h.engine.open({ voiceSessionId: 'vs-1' }),
    (error) => error.code === 'engine_not_ready' && /not ready within/.test(error.message),
  );
  assert.equal(h.children.length, 1, 'one worker was asked for, not one per attempt');
});

test('a worker that cannot spawn is logged and restarted, not fatal to the Gate', async () => {
  // Node reports a missing python as 'error' on the child and never 'exit'.
  // With no listener that is an uncaught exception, so one missing dependency
  // took the whole Gate down instead of this call's backoff.
  const h = await opened();
  const logs = [];
  const errors = [];
  h.engine.on('log', (line) => logs.push(line));
  h.engine.on('error', (event) => errors.push(event));

  h.children[0].emit('error', Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' }));

  assert.ok(logs.some((line) => line.includes('ENOENT')), 'the cause must reach the log');
  assert.deepEqual(errors, [], 'a spawn failure is a restart, not a dead call');
  assert.ok(due(h.scheduled, 10), 'a dead worker must take the backoff path');

  fire(due(h.scheduled, 10));
  assert.equal(h.children.length, 2);
});

test('a worker that never spawns ends the call once the restart budget is spent', async () => {
  const h = await opened({ maxRestarts: 1 });
  const errors = [];
  h.engine.on('error', (event) => errors.push(event));

  const spawnFailure = () => Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
  h.children[0].emit('error', spawnFailure());
  fire(due(h.scheduled, 10));
  h.children[1].emit('error', spawnFailure());

  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, true);
});

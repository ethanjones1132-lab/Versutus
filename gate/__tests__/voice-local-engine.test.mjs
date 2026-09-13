import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { LocalEngine } from '../core/voice/engines/local-engine.mjs';

class FakeChild extends EventEmitter {
  constructor(record) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      write: (line) => record.push(JSON.parse(line)),
      end: () => {},
    };
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function harness({ backoffMs = [1], maxRestarts = 2 } = {}) {
  const children = [];
  const scheduled = [];
  const spawn = () => {
    const record = [];
    const child = new FakeChild(record);
    child.record = record;
    children.push(child);
    return child;
  };
  const engine = new LocalEngine({
    paths: { python: 'python', models: 'models', worker: 'worker' },
    spawn,
    backoffMs,
    maxRestarts,
    schedule: (fn) => scheduled.push(fn),
  });
  return { engine, children, scheduled };
}

function notify(child, method, params) {
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

test('open starts the worker and tells it which session it serves', async () => {
  const { engine, children } = harness();
  await engine.open({ voiceSessionId: 'vs-1', botName: 'Scout' });
  assert.equal(children.length, 1);
  const opened = children[0].record.find((message) => message.method === 'voice.open');
  assert.deepEqual(opened.params, { voiceSessionId: 'vs-1', botName: 'Scout' });
});

test('a pushed 20 ms frame becomes a 16 kHz mono base64 chunk', async () => {
  const { engine, children } = harness();
  await engine.open({ voiceSessionId: 'vs-1' });
  const frame = Buffer.alloc(640, 7);
  engine.pushAudio(frame);
  const pushed = children[0].record.find((message) => message.method === 'voice.pushAudio');
  assert.equal(pushed.params.chunk.data, frame.toString('base64'));
  assert.equal(pushed.params.chunk.sampleRate, 16000);
  assert.equal(pushed.params.chunk.numChannels, 1);
});

test('worker notifications become engine events', async () => {
  const { engine, children } = harness();
  await engine.open({ voiceSessionId: 'vs-1' });

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
  const { engine, children } = harness();
  await engine.open({ voiceSessionId: 'vs-1' });

  const started = [];
  engine.on('userSpeechStart', (event) => started.push(event));
  notify(children[0], 'voice.userSpeechStart', { gen: 3 });

  assert.equal(started.length, 1);
  assert.equal(started[0].gen, 3);
});

test('an earlyEnd notification becomes an engine earlyEnd', async () => {
  const { engine, children } = harness();
  await engine.open({ voiceSessionId: 'vs-1' });

  const ends = [];
  engine.on('earlyEnd', (event) => ends.push(event));
  notify(children[0], 'voice.earlyEnd', { text: 'hello' });

  assert.equal(ends.length, 1);
  assert.equal(ends[0].text, 'hello');
});

test('a dead worker restarts on backoff and re-opens the session', async () => {
  const { engine, children, scheduled } = harness();
  await engine.open({ voiceSessionId: 'vs-1' });
  assert.equal(children.length, 1);

  children[0].emit('exit', 1);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(children.length, 2);
  const reopened = children[1].record.find((message) => message.method === 'voice.open');
  assert.deepEqual(reopened.params, { voiceSessionId: 'vs-1' });
});

test('a restarted worker still receives the call audio', async () => {
  const { engine, children, scheduled } = harness();
  await engine.open({ voiceSessionId: 'vs-1' });
  const errors = [];
  engine.on('error', (event) => errors.push(event));

  children[0].emit('exit', 1);
  scheduled.shift()();

  const frame = Buffer.alloc(640, 3);
  engine.pushAudio(frame);
  const pushed = children[1].record.find((message) => message.method === 'voice.pushAudio');
  assert.equal(pushed?.params.chunk.data, frame.toString('base64'));
  assert.equal(errors.length, 0, 'a restart is not a fatal error');
});

test('a worker that cannot stay up ends the call after the restart budget', async () => {
  const { engine, children, scheduled } = harness({ maxRestarts: 1 });
  await engine.open({ voiceSessionId: 'vs-1' });

  const errors = [];
  engine.on('error', (event) => errors.push(event));

  children[0].emit('exit', 1);
  scheduled.shift()();
  children[1].emit('exit', 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, true);
});

test('close stops the worker without a restart', async () => {
  const { engine, children, scheduled } = harness();
  await engine.open({ voiceSessionId: 'vs-1' });
  await engine.close();
  children[0].emit('exit', 0);
  assert.equal(scheduled.length, 0);
  assert.ok(children[0].killed);
});

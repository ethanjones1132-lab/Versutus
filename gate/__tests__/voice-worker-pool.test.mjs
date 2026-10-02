// The pool owns one worker process for every call, so these tests drive a fake
// worker that loads on command: nothing here spawns python or loads a model.
// What each one proves is in its name.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createVoiceWorkerPool } from '../core/voice/engines/worker-pool.mjs';

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

/** A fake worker: it says `voice.ready` only when a test tells it to. */
function harness({ idleMs = 60_000, readyTimeoutMs = 60_000, backoffMs = [10], maxRestarts = 5, realTimers = false } = {}) {
  const children = [];
  const scheduled = [];
  const lines = [];
  const pool = createVoiceWorkerPool({
    spawn: () => {
      const record = [];
      const child = new FakeChild(record);
      child.record = record;
      children.push(child);
      return child;
    },
    idleMs,
    readyTimeoutMs,
    backoffMs,
    maxRestarts,
    log: (line) => lines.push(line),
    // The restart, idle and ready timers are the ones a test has to fire
    // itself, so they are collected rather than run. `realTimers` is for the
    // one test that has to watch a timeout actually elapse.
    ...(realTimers
      ? {}
      : {
        schedule: (fn, ms) => {
          const handle = { fn, ms, cancelled: false };
          scheduled.push(handle);
          return handle;
        },
        cancel: (handle) => {
          if (handle) handle.cancelled = true;
        },
      }),
  });
  return { pool, children, scheduled, lines };
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

/** Warm the pool and let the worker it spawned finish loading. */
async function warmAndLoad(pool, children, index = 0, params) {
  const pending = pool.warm();
  await new Promise((done) => setImmediate(done));
  load(children[index], params);
  return pending;
}

/** Take a lease, letting the worker it had to spawn finish loading. */
async function leaseAndLoad(pool, children, index = 0, params) {
  const pending = pool.lease();
  await new Promise((done) => setImmediate(done));
  load(children[index], params);
  return pending;
}

function fire(handle) {
  handle.cancelled = false;
  handle.fn();
}

/** The scheduled timer with this delay, once. */
function due(scheduled, ms) {
  return scheduled.filter((handle) => !handle.cancelled && handle.ms === ms).at(-1);
}

async function openCall(pool, id) {
  const lease = await pool.lease();
  const pending = lease.request('voice.open', { voiceSessionId: id }, { timeoutMs: 1_000 });
  return { lease, pending };
}

test('warm resolves only once the worker says it can hear', async () => {
  const { pool, children, lines } = harness();
  let info = null;
  const pending = pool.warm().then((value) => { info = value; });
  await new Promise((done) => setImmediate(done));

  assert.equal(children.length, 1, 'the worker is spawned by the warm');
  assert.equal(info, null, 'a spawned worker that is still loading is not warm');

  load(children[0]);
  await pending;
  assert.equal(info.device, 'cuda');
  assert.equal(info.loadMs, 18_400);
  assert.ok(
    lines.some((line) => line === 'voice.worker ready loadMs=18400 device=cuda'),
    lines.join('\n'),
  );
});

test('a second call reuses the one warm process instead of loading again', async () => {
  const { pool, children } = harness();
  await warmAndLoad(pool, children);

  const first = await openCall(pool, 'vs-1');
  answer(children[0]);
  assert.deepEqual(await first.pending, { ok: true });
  first.lease.release();

  const second = await openCall(pool, 'vs-2');
  answer(children[0]);
  assert.deepEqual(await second.pending, { ok: true });

  assert.equal(children.length, 1, 'the models are loaded once for both calls');
  assert.equal(pool.leased, true);
});

test('releasing a lease ends the call and keeps the process', async () => {
  const { pool, children, scheduled } = harness();
  await warmAndLoad(pool, children);
  const { lease } = await openCall(pool, 'vs-1');
  answer(children[0]);

  lease.release();

  assert.ok(
    children[0].record.some((message) => message.method === 'voice.close'),
    'the worker is told the call ended',
  );
  assert.equal(children[0].killed, false, 'the shared process outlives the call');
  assert.equal(pool.leased, false);
  assert.equal(due(scheduled, 60_000).ms, 60_000, 'a released worker goes idle on a timer');
});

test('a second concurrent lease is refused with a named error', async () => {
  const { pool, children } = harness();
  await warmAndLoad(pool, children);
  const { lease } = await openCall(pool, 'vs-1');
  await assert.rejects(
    () => pool.lease(),
    (error) => error.code === 'worker_busy' && /already using/.test(error.message),
  );
  assert.equal(children.length, 1);
  lease.release();
});

test('a dead worker is respawned on backoff, re-warms and tells its lease', async () => {
  const { pool, children, scheduled } = harness({ backoffMs: [250, 500] });
  await warmAndLoad(pool, children);
  const { lease } = await openCall(pool, 'vs-1');
  answer(children[0]);
  const seen = [];
  lease.onNotification((message) => seen.push(message.method));

  children[0].emit('exit', 1);
  const restart = due(scheduled, 250);
  assert.ok(restart, 'the restart waits out the backoff');
  assert.equal(children.length, 1, 'nothing is respawned before the backoff elapses');

  fire(restart);
  assert.equal(children.length, 2);
  load(children[1]);
  await new Promise((done) => setImmediate(done));

  assert.deepEqual(seen, ['voice.ready'], 'the call learns the new process can hear');
  lease.release();
});

test('a worker nobody is using is not respawned on its own', async () => {
  const { pool, children, scheduled } = harness({ backoffMs: [250] });
  await warmAndLoad(pool, children);

  children[0].emit('exit', 1);

  assert.equal(children.length, 1, 'a warm worker that dies with no call waiting stays dead');
  assert.equal(due(scheduled, 250), undefined, 'nothing is respawned behind an idle Gate');
  assert.equal(pool.ready, null);
});

test('an idle worker is stopped, and the next lease warms a new one', async () => {
  const { pool, children, scheduled, lines } = harness({ idleMs: 60_000 });
  await warmAndLoad(pool, children);
  const { lease } = await openCall(pool, 'vs-1');
  answer(children[0]);
  lease.release();

  fire(due(scheduled, 60_000));
  assert.equal(children[0].killed, true, 'an idle worker gives the GPU back');
  assert.ok(lines.some((line) => line === 'voice.worker idle afterMs=60000'), lines.join('\n'));

  const next = await leaseAndLoad(pool, children, 1);
  assert.equal(children.length, 2, 'the next call loads a worker again');
  next.release();
});

test('a worker that never loads is written off with a named error', async () => {
  const { pool, children } = harness({ readyTimeoutMs: 20, realTimers: true });
  await assert.rejects(
    () => pool.warm(),
    (error) => error.code === 'worker_not_ready' && /did not load its models/.test(error.message),
  );
  assert.equal(children[0].killed, true, 'a worker that cannot hear is not left holding the GPU');
});

test('a crash loop past the restart budget fails the call, not just the warm', async () => {
  const { pool, children, scheduled } = harness({ backoffMs: [10], maxRestarts: 1 });
  await warmAndLoad(pool, children);
  const lease = await pool.lease();
  const seen = [];
  lease.onNotification((message) => seen.push(message.params));

  children[0].emit('exit', 1);
  fire(due(scheduled, 10));
  assert.equal(children.length, 2);
  const beforeSecondDeath = scheduled.length;
  children[1].emit('exit', 1);

  assert.equal(seen.length, 1, 'the call is told once, so it can end with a reason');
  assert.equal(seen[0].code, 'engine_failed');
  assert.equal(seen[0].fatal, true);
  assert.match(seen[0].message, /exited 2 times/);
  assert.equal(pool.leased, false, 'the dead lease is released for the next call');
  assert.equal(scheduled.length, beforeSecondDeath, 'a spent budget respawns nothing');
});

test('a worker that once became ready gets a fresh restart budget', async () => {
  const { pool, children, scheduled } = harness({ backoffMs: [10], maxRestarts: 1 });
  await warmAndLoad(pool, children);
  const lease = await pool.lease();

  children[0].emit('exit', 1);
  fire(due(scheduled, 10));
  load(children[1]);

  children[1].emit('exit', 1);
  fire(due(scheduled, 10));
  assert.equal(children.length, 3, 'a worker that had become ready is not written off for good');
  load(children[2]);
  lease.release();
});

test('a worker that cannot spawn is logged and restarted, never fatal to the Gate', async () => {
  const { pool, children, scheduled, lines } = harness({ backoffMs: [250] });
  await warmAndLoad(pool, children);
  const lease = await pool.lease();

  // Node reports a missing python as 'error' on the child and never 'exit';
  // both count as one death so the budget is spent once per worker.
  children[0].emit('error', Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' }));
  children[0].emit('exit', 1);

  assert.ok(lines.some((line) => line.includes('ENOENT')), lines.join('\n'));
  assert.equal(due(scheduled, 250)?.ms, 250, 'one death, one restart');
  fire(due(scheduled, 250));
  assert.equal(children.length, 2);
  lease.release();
});

test('shutdown stops the worker and refuses everything after it', async () => {
  const { pool, children, scheduled } = harness();
  await warmAndLoad(pool, children);
  const lease = await pool.lease();

  await pool.shutdown();

  assert.equal(children[0].killed, true, 'the worker does not outlive the Gate');
  assert.equal(scheduled.every((handle) => handle.cancelled), true, 'no timer survives the Gate');
  lease.release();
  await assert.rejects(() => pool.lease(), (error) => error.code === 'worker_pool_shutdown');
  await assert.rejects(() => pool.warm(), (error) => error.code === 'worker_pool_shutdown');
});

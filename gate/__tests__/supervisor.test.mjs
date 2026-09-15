import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Supervisor } from '../core/service/supervisor.mjs';

let nextPid = 50000;

/** A fake Gate child: an EventEmitter with a pid and a recorded send. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = nextPid += 1;
  child.sent = [];
  child.send = (message) => {
    child.sent.push(message);
    return true;
  };
  return child;
}

/**
 * A schedule that records delays and runs them on real timers — short test
 * timings keep the suite fast while the recorded delays prove the backoff.
 */
function harness(overrides = {}) {
  const delays = [];
  const children = [];
  const killed = [];
  const states = [];
  let nowMs = 1_000_000;
  const sup = new Supervisor({
    spawnGate: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probe: async () => true,
    killTree: (pid) => {
      killed.push(pid);
      const child = children.find((entry) => entry.pid === pid);
      child?.emit('exit', null, 'SIGKILL');
    },
    schedule: (fn, ms) => {
      delays.push(ms);
      return setTimeout(fn, ms);
    },
    now: () => nowMs,
    writeState: (state) => states.push(state),
    log: () => {},
    backoffMs: [10, 20, 40],
    graceMs: 5,
    probeIntervalMs: 5,
    stableMs: 60,
    stopKillMs: 10,
    codeRoot: 'C:\\Projects\\Versutus',
    gitHead: 'abc123',
    ...overrides,
  });
  return {
    sup, delays, children, killed, states,
    advance: (ms) => { nowMs += ms; },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a crash restarts with backoff, not immediately', async () => {
  const h = harness();
  h.sup.start();
  assert.equal(h.children.length, 1);
  h.children[0].emit('exit', 1, null);
  assert.equal(h.children.length, 1, 'no instant respawn');
  await sleep(50);
  assert.equal(h.children.length, 2, 'respawned after the first backoff');
  assert.ok(h.delays.includes(10), `delays were ${h.delays}`);
  await h.sup.stop();
});

test('backoff resets after ten quiet minutes up', async () => {
  const h = harness();
  h.sup.start();
  h.children[0].emit('exit', 1, null); // failures=1 → 10 ms
  await sleep(30);
  assert.equal(h.children.length, 2);
  h.advance(61_000); // the second child stayed up past stableMs
  h.children[1].emit('exit', 1, null); // failures reset → 10 ms again
  await sleep(30);
  assert.equal(h.children.length, 3);
  assert.deepEqual(h.delays.filter((ms) => ms >= 10).slice(0, 2), [10, 10]);
  await h.sup.stop();
});

test('exit code 75 waits 60 s instead of hot-looping', async () => {
  const delays = [];
  const child = fakeChild();
  const sup = new Supervisor({
    spawnGate: () => child,
    probe: async () => true,
    killTree: () => {},
    schedule: (fn, ms) => {
      delays.push(ms);
      // The 60 s conflict wait itself is the assertion — fire only the
      // short watchdog so stop() below can still resolve.
      if (ms < 60000) return setTimeout(fn, ms);
      return 0;
    },
    stopKillMs: 10,
    writeState: () => {},
    log: () => {},
  });
  sup.start();
  child.emit('exit', 75, null);
  assert.ok(delays.includes(60000), `delays were ${delays}`);
  await sup.stop();
});

test('four failed probes kill the child and restart it', async () => {
  // Only the first child is unhealthy. A probe that always failed raced the
  // host's timer resolution: with fast timers the second child was killed
  // too and a third spawned inside a fixed wait.
  let probes = 0;
  const h = harness({ probe: async () => { probes += 1; return probes > 4; } });
  try {
    h.sup.start();
    const first = h.children[0];
    const deadline = Date.now() + 2000;
    while (h.children.length < 2 && Date.now() < deadline) await sleep(5);
    assert.ok(h.killed.includes(first.pid), 'the unhealthy child was tree-killed');
    assert.equal(h.children.length, 2, 'the kill restarted the Gate');
  } finally {
    // Stop even on a failed assertion: a live supervisor keeps real timers
    // running and the test runner never exits.
    await h.sup.stop();
  }
});

test('a graceful stop asks, kills after the cap, and never respawns', async () => {
  const h = harness();
  h.sup.start();
  const first = h.children[0];
  // The child ignores the shutdown message: the cap must still end it.
  const stopped = h.sup.stop();
  assert.deepEqual(first.sent, [{ type: 'shutdown' }]);
  await stopped;
  assert.ok(h.killed.includes(first.pid), 'the deaf child was tree-killed');
  const count = h.children.length;
  await sleep(40);
  assert.equal(h.children.length, count, 'stopped means stopped');
  assert.equal(h.states.at(-1).status, 'stopped');
  assert.equal(h.states.at(-1).childPid, null);
});

test('a graceful stop resolves when the child exits, without waiting out the kill cap', async () => {
  const scheduled = new Map();
  const cancelled = [];
  const h = harness({
    stopKillMs: 60_000,
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      scheduled.set(id, ms);
      return id;
    },
    cancel: (id) => {
      cancelled.push(scheduled.get(id));
      clearTimeout(id);
    },
  });
  h.sup.start();
  const child = h.children[0];
  // A well-behaved Gate: it honours the shutdown message and exits at once.
  child.send = (message) => {
    child.sent.push(message);
    if (message?.type === 'shutdown') setTimeout(() => child.emit('exit', 0, null), 5);
    return true;
  };
  const outcome = await Promise.race([
    h.sup.stop().then(() => 'resolved'),
    sleep(500).then(() => 'still pending'),
  ]);
  assert.equal(outcome, 'resolved');
  assert.deepEqual(h.killed, [], 'a child that exited on request is never tree-killed');
  assert.equal(h.states.at(-1).status, 'stopped');
  assert.ok(cancelled.includes(60_000), 'the kill-cap timer is cancelled, so nothing holds the process open');
});

test('state reports the transition fields on every change', async () => {
  const h = harness();
  h.sup.start();
  const running = h.states.at(-1);
  assert.equal(running.status, 'running');
  assert.equal(running.childPid, h.children[0].pid);
  assert.equal(running.restarts, 0);
  assert.equal(running.codeRoot, 'C:\\Projects\\Versutus');
  assert.equal(running.gitHead, 'abc123');
  h.children[0].emit('exit', 1, null);
  await sleep(50);
  assert.equal(h.states.at(-1).restarts, 1);
  assert.ok(h.states.at(-1).lastExit !== null);
  await h.sup.stop();
});

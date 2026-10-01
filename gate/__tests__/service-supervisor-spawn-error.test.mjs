import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Supervisor } from '../core/service/supervisor.mjs';

let nextPid = 47000;

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
 * The same shape as supervisor.test.mjs's harness, with the spawn itself
 * scriptable — a child that reports 'error' the way node does when the
 * interpreter has moved or the code root is stale.
 */
function harness({ onSpawn, ...overrides } = {}) {
  const delays = [];
  const children = [];
  const killed = [];
  const states = [];
  const logs = [];
  const sup = new Supervisor({
    spawnGate: () => {
      const child = fakeChild();
      children.push(child);
      onSpawn?.(child, children.length - 1);
      return child;
    },
    probe: async () => true,
    killTree: (pid) => {
      killed.push(pid);
      children.find((entry) => entry.pid === pid)?.emit('exit', null, 'SIGKILL');
    },
    schedule: (fn, ms) => {
      delays.push(ms);
      return setTimeout(fn, ms);
    },
    writeState: (state) => states.push(state),
    log: (line) => logs.push(line),
    backoffMs: [10, 20, 40],
    graceMs: 5,
    probeIntervalMs: 5,
    stopKillMs: 10,
    codeRoot: 'C:\\Projects\\Versutus',
    gitHead: 'abc123',
    ...overrides,
  });
  return { sup, delays, children, killed, states, logs };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const spawnError = () => Object.assign(new Error('spawn C:\\no-such\\node.exe ENOENT'), { code: 'ENOENT' });

test('a spawn failure is one crash and one backoff, not a dead supervisor', async () => {
  // Before the fix the child had no 'error' listener, so emitting it here threw
  // an uncaught exception out of a supervisor that exists to survive crashes.
  const h = harness();
  try {
    h.sup.start();
    const first = h.children[0];
    assert.doesNotThrow(() => first.emit('error', spawnError()));
    assert.equal(h.children.length, 1, 'a spawn failure never respawns instantly');
    assert.equal(h.states.at(-1).status, 'restarting');
    assert.equal(h.states.at(-1).restarts, 1, 'exactly one crash is recorded');
    assert.equal(h.states.at(-1).childPid, null);
    assert.ok(h.delays.includes(10), `the first backoff applies, delays were ${h.delays}`);

    await sleep(50);
    assert.equal(h.children.length, 2, 'the supervisor retried after the backoff');
    assert.ok(
      h.logs.some((line) => /spawn failed: spawn C:\\no-such\\node\.exe ENOENT/.test(line)),
      `the log must name the executable, logs were ${JSON.stringify(h.logs)}`,
    );
    assert.ok(
      h.logs.some((line) => line.includes('C:\\Projects\\Versutus')),
      'the log must name the code root the spawn used',
    );
  } finally {
    await h.sup.stop();
  }
});

test('a repeated spawn failure follows the backoff instead of spinning', async () => {
  // Every spawn fails the same way. The supervisor must stay up and spend one
  // restart per attempt on the escalating schedule, not hot-loop on a stale
  // code root — the case `service run` exists to outlive.
  const h = harness({ onSpawn: (child) => { setTimeout(() => child.emit('error', spawnError()), 1); } });
  try {
    h.sup.start();
    const deadline = Date.now() + 2000;
    while (h.children.length < 4 && Date.now() < deadline) await sleep(5);
    // Read both together: a fifth retry may land between the two reads, and the
    // newest child's own 'error' (a 1 ms timer) may not have fired yet.
    const spawned = h.children.length;
    const restarts = h.states.at(-1).restarts;
    assert.ok(spawned >= 4, 'each failed attempt is retried');
    assert.deepEqual(
      h.delays.filter((ms) => ms >= 10).slice(0, 3),
      [10, 20, 40],
      `backoff must escalate per attempt, delays were ${h.delays}`,
    );
    assert.ok(
      restarts === spawned || restarts === spawned - 1,
      `one restart per FAILED attempt (the newest spawn may not have failed yet): spawned ${spawned}, restarts ${restarts}`,
    );
  } finally {
    await h.sup.stop();
  }
});

test('error then exit is one crash, not two restarts', async () => {
  // node may report both for one failed launch; each must not spend its own
  // backoff attempt, or the restart budget doubles per failure.
  const h = harness();
  try {
    h.sup.start();
    const first = h.children[0];
    assert.doesNotThrow(() => {
      first.emit('error', spawnError());
      first.emit('exit', 1, null);
    });
    assert.equal(h.states.at(-1).restarts, 1, 'one launch, one restart');
    await sleep(60);
    assert.equal(h.children.length, 2, 'exactly one retry was scheduled');
  } finally {
    await h.sup.stop();
  }
});

test('a stop during a failed spawn still reaches stopped', async () => {
  const h = harness({ onSpawn: (child) => { setTimeout(() => child.emit('error', spawnError()), 1); } });
  h.sup.start();
  await h.sup.stop();
  assert.equal(h.states.at(-1).status, 'stopped');
  const count = h.children.length;
  await sleep(60);
  assert.equal(h.children.length, count, 'a stopped supervisor never respawns');
});
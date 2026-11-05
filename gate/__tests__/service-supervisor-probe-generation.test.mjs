import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Supervisor } from '../core/service/supervisor.mjs';

let nextPid = 50000;

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

test('stale health probes are discarded after replacement or stop', async () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const drainMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  for (const staleOutcome of ['healthy', 'unhealthy', 'rejected']) {
    const tasks = new Map();
    const children = [];
    const killed = [];
    const states = [];
    const logs = [];
    const probes = [];
    let taskId = 0;
    const now = 1_000_000;
    const sup = new Supervisor({
      spawnGate: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
      probe: () => probes.shift()(),
      killTree: (pid) => {
        killed.push(pid);
        children.find((child) => child.pid === pid)?.emit('exit', null, 'SIGKILL');
      },
      schedule: (fn, ms) => {
        const id = ++taskId;
        tasks.set(id, { fn, ms });
        return id;
      },
      cancel: (id) => tasks.delete(id),
      now: () => now,
      writeState: (state) => states.push(state),
      log: (line) => logs.push(line),
      backoffMs: [10, 20],
      graceMs: 5,
      probeIntervalMs: 5,
      stableMs: 60,
      stopKillMs: 10,
    });
    const runDelay = (ms) => {
      const entry = [...tasks.entries()].find(([, task]) => task.ms === ms);
      assert.ok(entry, `a ${ms} ms task is scheduled; tasks were ${JSON.stringify([...tasks.values()].map((task) => task.ms))}`);
      const [id, task] = entry;
      tasks.delete(id);
      task.fn();
    };

    const staleProbe = deferred();
    const replacementProbe = deferred();
    probes.push(() => staleProbe.promise, () => replacementProbe.promise);
    sup.start();
    const childA = children[0];
    runDelay(5);
    assert.equal(probes.length, 1, 'child A probe started and took its queued result');

    childA.emit('exit', 1, null);
    runDelay(10);
    const childB = children[1];
    runDelay(5);
    assert.equal(probes.length, 0, 'replacement B probe started after its grace period');

    const stateCountBeforeStaleResult = states.length;
    const logCountBeforeStaleResult = logs.length;
    if (staleOutcome === 'healthy') staleProbe.resolve(true);
    else if (staleOutcome === 'unhealthy') staleProbe.resolve(false);
    else staleProbe.reject(new Error('stale probe rejection'));
    await drainMicrotasks();

    assert.equal(tasks.size, 0, `${staleOutcome} result must not start an extra probe chain`);
    assert.equal(states.length, stateCountBeforeStaleResult, `${staleOutcome} result must not update health state`);
    assert.equal(sup._lastHealthyAt, null, `${staleOutcome} result must not change lastHealthyAt`);
    assert.deepEqual(killed, [], `${staleOutcome} result must not kill a child`);
    assert.equal(sup._child, childB, 'replacement B remains the owned child');
    assert.equal(
      logs.slice(logCountBeforeStaleResult).some((line) => /health probe failed/.test(line)),
      false,
      `${staleOutcome} result must not report a current-child probe failure`,
    );

    replacementProbe.resolve(true);
    await drainMicrotasks();
    assert.ok(sup._lastHealthyAt, 'B healthy result updates health state');
    assert.equal([...tasks.values()].filter((task) => task.ms === 5).length, 1, 'B schedules its normal next probe');

    for (let failure = 1; failure <= 4; failure += 1) {
      probes.push(async () => false);
      runDelay(5);
      await drainMicrotasks();
      assert.ok(logs.includes(`health probe failed ${failure} in a row`), `B failure ${failure} is counted`);
      if (failure < 4) {
        assert.equal(killed.length, 0, `B is not killed before failure ${failure + 1}`);
        assert.equal([...tasks.values()].filter((task) => task.ms === 5).length, 1, 'B retains its probe cadence');
      }
    }
    assert.deepEqual(killed, [childB.pid], 'four current-child failures kill B');
  }

  const pendingProbe = deferred();
  const stopTasks = new Map();
  const stopStates = [];
  let stopTaskId = 0;
  const child = fakeChild();
  const stopped = new Supervisor({
    spawnGate: () => child,
    probe: () => pendingProbe.promise,
    killTree: () => {},
    schedule: (fn, ms) => {
      const id = ++stopTaskId;
      stopTasks.set(id, { fn, ms });
      return id;
    },
    cancel: (id) => stopTasks.delete(id),
    now: () => 1_000_000,
    writeState: (state) => stopStates.push(state),
    graceMs: 5,
    stopKillMs: 10,
  });
  stopped.start();
  const graceTask = [...stopTasks.entries()].find(([, task]) => task.ms === 5);
  assert.ok(graceTask, 'initial grace timer is scheduled');
  stopTasks.delete(graceTask[0]);
  graceTask[1].fn();
  const stopping = stopped.stop();
  child.emit('exit', 0, null);
  await stopping;
  const stateCountAtStop = stopStates.length;
  pendingProbe.resolve(true);
  await drainMicrotasks();
  assert.equal(stopTasks.size, 0, 'stop leaves no pending scheduled work');
  assert.equal(stopStates.length, stateCountAtStop, 'probe completion after stop cannot publish health state');
  assert.equal(stopStates.at(-1).status, 'stopped');
});

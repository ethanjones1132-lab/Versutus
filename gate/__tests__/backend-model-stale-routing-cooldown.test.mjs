import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBackendModelRouter } from '../core/backend-model-route.mjs';

const BACKENDS = [{ id: 'hermes-local', adapterId: 'hermes' }];
const OLD_MODELS = [{ id: 'kilo/old-model', available: true }];
const NEW_MODELS = [{ id: 'kilo/new-model', available: true }];

test('a failed stale routing refresh keeps its copy and cools down subsequent turns', async () => {
  const clock = manualClock();
  let reads = 0;
  const router = createBackendModelRouter({
    listBackends: async () => BACKENDS,
    listModels: () => {
      reads += 1;
      if (reads === 1) return OLD_MODELS;
      if (reads === 2) return Promise.reject(new Error('environment refused the catalogue'));
      return NEW_MODELS;
    },
    now: clock.now,
    ttlMs: 100,
    staleMs: 10_000,
    readTimeoutMs: 5,
    timers: clock.timers,
  });

  assert.equal(await router.backendFor('kilo/old-model', 'kilo'), 'hermes-local');
  assert.equal(reads, 1);

  clock.advance(101);
  assert.equal(await router.backendFor('kilo/old-model', 'kilo'), 'hermes-local');
  assert.equal(reads, 2, 'the expired copy caused one failed refresh');
  assert.equal(clock.pending(), 0, 'the refusal did not leave a deadline armed');

  for (let turn = 0; turn < 3; turn += 1) {
    assert.equal(await router.backendFor('kilo/old-model', 'kilo'), 'hermes-local');
    assert.equal(reads, 2, 'the stale copy was routed without another read');
    assert.equal(clock.pending(), 0, 'a cooldown hit did not wait on a read');
  }

  clock.advance(100);
  assert.deepEqual(
    await Promise.all([
      router.backendFor('kilo/new-model', 'kilo'),
      router.backendFor('kilo/new-model', 'kilo'),
    ]),
    ['hermes-local', 'hermes-local'],
  );
  assert.equal(reads, 3, 'cooldown expiry allowed one shared recovery refresh');
  assert.equal(await router.backendFor('kilo/new-model', 'kilo'), 'hermes-local');
  assert.equal(await router.backendFor('kilo/old-model', 'kilo'), null, 'recovery replaced the stale copy');
  assert.equal(reads, 3, 'the recovered copy replaced the old one');
});

test('a failed cold routing read has no models and remains bounded by the cooldown', async () => {
  const clock = manualClock();
  let reads = 0;
  const router = createBackendModelRouter({
    listBackends: async () => BACKENDS,
    listModels: () => {
      reads += 1;
      return Promise.reject(new Error('environment refused the catalogue'));
    },
    now: clock.now,
    ttlMs: 100,
    readTimeoutMs: 5,
    timers: clock.timers,
  });

  assert.equal(await router.backendFor('kilo/missing', 'kilo'), null);
  assert.equal(reads, 1);
  assert.equal(await router.backendFor('kilo/missing', 'kilo'), null);
  assert.equal(reads, 1, 'a missing copy still uses the failure cooldown');
  assert.equal(clock.pending(), 0);

  clock.advance(100);
  assert.equal(await router.backendFor('kilo/missing', 'kilo'), null);
  assert.equal(reads, 2, 'expiry permits a new attempt when there is no cached copy');
});

test('a short routing waiter does not shorten a concurrent catalogue response', async () => {
  const clock = manualClock();
  const read = deferred();
  let reads = 0;
  const router = createBackendModelRouter({
    listBackends: async () => BACKENDS,
    listModels: () => { reads += 1; return read.promise; },
    readTimeoutMs: 5,
    responseTimeoutMs: 60,
    timers: clock.timers,
  });

  let responseSettled = false;
  const response = router.cataloguesFor(BACKENDS).then((rows) => {
    responseSettled = true;
    return rows;
  });
  await tick();
  const routing = router.backendFor('kilo/new-model', 'kilo');
  await tick();
  assert.equal(reads, 1, 'the routing caller joined the live response read');

  assert.equal(clock.fire(5), 1, 'only the routing deadline fired');
  await tick();
  assert.equal(await routing, null, 'routing honored its own short deadline');
  assert.equal(responseSettled, false, 'the response retained its longer deadline');

  read.resolve(NEW_MODELS);
  assert.deepEqual((await response).get('hermes-local'), NEW_MODELS);
  assert.equal(responseSettled, true);
  assert.equal(reads, 1);
  assert.equal(await router.backendFor('kilo/new-model', 'kilo'), 'hermes-local');
  assert.equal(reads, 1, 'response success populated the routing copy and cleared failure state');
  assert.equal(clock.pending(), 0, 'all caller deadlines were cleared');
});

function manualClock() {
  let at = 1_000;
  let nextId = 1;
  const pending = new Set();
  return {
    now: () => at,
    advance(ms) { at += ms; },
    timers: {
      setTimeout(callback, ms) {
        const handle = { id: nextId, ms, callback };
        nextId += 1;
        handle.unref = () => handle;
        pending.add(handle);
        return handle;
      },
      clearTimeout(handle) { pending.delete(handle); },
    },
    fire(ms) {
      const due = [...pending].filter((handle) => handle.ms === ms);
      for (const handle of due) {
        pending.delete(handle);
        handle.callback();
      }
      return due.length;
    },
    pending: () => pending.size,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

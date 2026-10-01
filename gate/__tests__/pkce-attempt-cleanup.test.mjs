import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

import { createPkceAttempt, consumePkceAttempt } from '../core/providers/oauth/pkce-callback.mjs';
import { AttemptStore } from '../core/providers/oauth/attempt-store.mjs';

// Each attempt opens a loopback listener for its callback, and only the path
// that answered a callback or an explicit `cancel` closed it. An attempt nobody
// finished in time left the listener open and the attempt in the store for the
// life of the process, so a Gate that had been asked to authorize anything was
// holding sockets no surface could reach, name or revoke.

/** Resolve once nothing accepts on the attempt's loopback port any more. */
function refuses(port, ms = 2000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    const deadline = setTimeout(() => fail(new Error('the port still accepts')), ms);
    deadline.unref?.();
    socket.once('connect', () => {
      clearTimeout(deadline);
      socket.destroy();
      reject(new Error('the callback listener is still open'));
    });
    socket.once('error', (error) => {
      clearTimeout(deadline);
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

const untilRefuses = async (port) => {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      await refuses(port, 200);
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};

test('an expired attempt closes its listener and leaves the store', async () => {
  const store = new AttemptStore();
  const attempt = await createPkceAttempt(store, { providerId: 'p', ttlMs: 30 });
  const { port } = new URL(attempt.redirectUri);

  assert.ok(store.get(attempt.id), 'the attempt is stored while it can still be used');
  await assert.rejects(attempt.callback, /attempt expired/);

  assert.ok(await untilRefuses(port), 'an expired attempt must not keep its callback listener');
  assert.equal(store.get(attempt.id), undefined, 'an expired attempt must not stay in the store');
});

test('a served callback closes its listener too', async () => {
  const store = new AttemptStore();
  const attempt = await createPkceAttempt(store, { providerId: 'p', ttlMs: 60_000 });
  const { port } = new URL(attempt.redirectUri);

  const response = await fetch(`${attempt.redirectUri}?code=c&state=${attempt.state}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await attempt.callback, { code: 'c', state: attempt.state, error: null });

  assert.ok(await untilRefuses(port), 'the one callback has been served; the listener is done');
  assert.equal(store.get(attempt.id), undefined);
});

test('closing twice, and closing after an expiry, is safe', async () => {
  const store = new AttemptStore();
  const expired = await createPkceAttempt(store, { providerId: 'p', ttlMs: 20 });
  await assert.rejects(expired.callback, /attempt expired/);
  await expired.close();
  await expired.close();

  const live = await createPkceAttempt(store, { providerId: 'p', ttlMs: 60_000 });
  await live.close();
  await live.close();
  assert.equal(store.get(live.id), undefined);
});

test('consumePkceAttempt still binds state, one use and expiry', async () => {
  const store = new AttemptStore();
  const attempt = await createPkceAttempt(store, { providerId: 'p', ttlMs: 60_000 });
  try {
    assert.throws(() => consumePkceAttempt(store, attempt.id, 'not-the-state'), /state mismatch/);
    const consumed = consumePkceAttempt(store, attempt.id, attempt.state);
    assert.equal(consumed.providerId, 'p');
    assert.throws(() => consumePkceAttempt(store, attempt.id, attempt.state), /one-use|unknown/i);
  } finally {
    await attempt.close();
  }

  // Expiry is the one binding that cannot be reached by waiting it out any more:
  // an attempt past its ttl now releases itself (see the first test here), so it
  // is gone from the store and `consume` reports it as unknown. The check that
  // remains is the one that still runs — the attempt's own `expiresAt`, moved
  // back by hand so the assertion is about the rule and not about a race.
  const expiring = await createPkceAttempt(store, { providerId: 'p', ttlMs: 60_000 });
  try {
    expiring.expiresAt = Date.now() - 1;
    assert.throws(() => consumePkceAttempt(store, expiring.id, expiring.state), /expir/i);
  } finally {
    await expiring.close();
  }
  assert.equal(store.get(expiring.id), undefined);
});

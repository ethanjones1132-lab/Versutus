import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPkceAttempt } from '../core/providers/oauth/pkce-callback.mjs';
import { AttemptStore } from '../core/providers/oauth/attempt-store.mjs';

// Resolve to `{ state: 'pending' }` unless the promise settles within `ms`.
// The loopback listener answers on the same tick it settles the callback, so a
// short window is enough: a request that ended the attempt would already have
// settled by the time its HTTP response came back.
function settleWithin(promise, ms) {
  return Promise.race([
    promise.then(
      (value) => ({ state: 'resolved', value }),
      (error) => ({ state: 'rejected', error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ state: 'pending' }), ms)),
  ]);
}

test('PKCE callback refuses a mismatched state and keeps waiting for the real one', async () => {
  const store = new AttemptStore();
  const attempt = await createPkceAttempt(store, { providerId: 'fake-oauth', ttlMs: 5000 });
  try {
    // A state that is not this attempt's is refused, and refusing it must not
    // end the attempt: the sign-in flow is still waiting, the store still holds
    // the attempt, and no code was delivered.
    const wrongState = await fetch(`${attempt.redirectUri}?code=stolen-code&state=not-this-state`);
    assert.equal(wrongState.status, 400);
    await wrongState.text();

    const noState = await fetch(`${attempt.redirectUri}?code=stolen-code`);
    assert.equal(noState.status, 400);
    await noState.text();

    const stillWaiting = await settleWithin(attempt.callback, 100);
    assert.equal(stillWaiting.state, 'pending');
    assert.equal(store.get(attempt.id), attempt);
    assert.equal(attempt.used, false);

    // The genuine callback, carrying the state the attempt minted, still
    // completes the sign-in with the code and state it was sent.
    const response = await fetch(`${attempt.redirectUri}?code=auth-code&state=${attempt.state}`);
    assert.equal(response.status, 200);
    const received = await attempt.callback;
    assert.equal(received.code, 'auth-code');
    assert.equal(received.state, attempt.state);
  } finally {
    await attempt.close();
  }
});

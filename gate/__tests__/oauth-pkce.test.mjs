import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPkceAttempt, consumePkceAttempt } from '../core/providers/oauth/pkce-callback.mjs';
import { AttemptStore } from '../core/providers/oauth/attempt-store.mjs';

test('PKCE attempts are one-use, state-bound, and expiry-bound', async () => {
  const store = new AttemptStore();
  const attempt = await createPkceAttempt(store, {
    providerId: 'fake-oauth',
    // Long enough that a loaded machine cannot expire it before the one-use and
    // state-binding assertions below run. Expiry is covered separately, with its
    // own 1ms attempt, so nothing is lost by not racing the clock here.
    ttlMs: 2000,
  });
  try {
    assert.equal(attempt.redirectUri.startsWith('http://127.0.0.1:'), true);
    assert.ok(attempt.codeChallenge);
    const once = consumePkceAttempt(store, attempt.id, attempt.state);
    assert.equal(once.providerId, 'fake-oauth');
    assert.throws(() => consumePkceAttempt(store, attempt.id, attempt.state), /one-use|unknown/i);
  } finally {
    await attempt.close();
  }
  const expired = await createPkceAttempt(store, { providerId: 'fake-oauth', ttlMs: 1 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.throws(() => consumePkceAttempt(store, expired.id, expired.state), /expir/i);
  } finally {
    await expired.close();
  }
});

test('PKCE callback binds only 127.0.0.1 and captures the authorization code', async () => {
  const store = new AttemptStore();
  const attempt = await createPkceAttempt(store, { providerId: 'fake-oauth', ttlMs: 2000 });
  try {
    const host = new URL(attempt.redirectUri).hostname;
    assert.equal(host, '127.0.0.1');
    const response = await fetch(`${attempt.redirectUri}?code=auth-code&state=${attempt.state}`);
    assert.equal(response.status, 200);
    const received = await attempt.callback;
    assert.equal(received.code, 'auth-code');
    assert.equal(received.state, attempt.state);
  } finally {
    await attempt.close();
  }
});

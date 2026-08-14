import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPkceAttempt, consumePkceAttempt } from '../core/providers/oauth/pkce-callback.mjs';
import { AttemptStore } from '../core/providers/oauth/attempt-store.mjs';

test('PKCE attempts are one-use, state-bound, and expiry-bound', async () => {
  const store = new AttemptStore();
  const attempt = await createPkceAttempt(store, {
    providerId: 'fake-oauth',
    ttlMs: 50,
  });
  assert.equal(attempt.redirectUri.startsWith('http://127.0.0.1:'), true);
  assert.ok(attempt.codeChallenge);
  const once = consumePkceAttempt(store, attempt.id, attempt.state);
  assert.equal(once.providerId, 'fake-oauth');
  assert.throws(() => consumePkceAttempt(store, attempt.id, attempt.state), /one-use|unknown/i);
  const expired = await createPkceAttempt(store, { providerId: 'fake-oauth', ttlMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(() => consumePkceAttempt(store, expired.id, expired.state), /expir/i);
});

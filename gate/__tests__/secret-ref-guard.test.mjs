import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeCredential } from '../core/capabilities/secrets.mjs';

/**
 * The vault names each file after its ref, so a ref that is itself a key writes
 * the secret into a filename. That happened on 2026-08-14, in a directory that
 * was not gitignored at the time.
 */
test('known key prefixes are rejected', () => {
  for (const value of [
    'sk-Q0f4ioEsl3tE7Hm4ahCvlLIfuPoKxp6OAgXxaoy3mbDP22JR',
    'sk_live_abc123',
    'gsk_abcdef',
    'xai-abcdef',
    'ghp_abcdef',
    'github_pat_11ABCDEFG',
  ]) {
    assert.equal(looksLikeCredential(value), true, `${value} must be rejected`);
  }
});

test('a prefix is matched regardless of case', () => {
  assert.equal(looksLikeCredential('SK-ABCDEF'), true);
});

test('a long unbroken token is rejected', () => {
  assert.equal(looksLikeCredential('a'.repeat(40)), true);
});

test('ordinary ref names are accepted', () => {
  for (const value of ['my-api-key', 'nvidia/api-key', 'memory.token', 'openai_key', 'k']) {
    assert.equal(looksLikeCredential(value), false, `${value} must be accepted`);
  }
});

test('a long name with separators is still a name', () => {
  assert.equal(looksLikeCredential('provider/some-very-long-instance-name/api-key'), false);
});

test('empty and non-string refs do not throw', () => {
  assert.equal(looksLikeCredential(undefined), false);
  assert.equal(looksLikeCredential(''), false);
  assert.equal(looksLikeCredential(null), false);
});

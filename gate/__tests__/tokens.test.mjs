import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TokenStore } from '../core/tokens.mjs';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-tokens-'));
  return new TokenStore(join(dir, 'tokens.json'));
}

test('generates a token on first use and reuses it after', async () => {
  const tokens = await store();
  const first = await tokens.ensureToken();
  const second = await tokens.ensureToken();

  assert.equal(first, second);
  assert.ok(first.length >= 32);
});

test('accepts the issued token', async () => {
  const tokens = await store();
  const token = await tokens.ensureToken();
  assert.equal(await tokens.verify(`Bearer ${token}`), true);
});

test('rejects a wrong token', async () => {
  const tokens = await store();
  await tokens.ensureToken();
  assert.equal(await tokens.verify('Bearer not-the-token'), false);
});

test('rejects a missing or malformed header', async () => {
  const tokens = await store();
  await tokens.ensureToken();

  assert.equal(await tokens.verify(undefined), false);
  assert.equal(await tokens.verify(''), false);
  assert.equal(await tokens.verify('token-without-scheme'), false);
});

test('rotate replaces the previous token', async () => {
  const tokens = await store();
  const original = await tokens.ensureToken();
  const rotated = await tokens.rotate();

  assert.notEqual(original, rotated);
  assert.equal(await tokens.verify(`Bearer ${original}`), false);
  assert.equal(await tokens.verify(`Bearer ${rotated}`), true);
});

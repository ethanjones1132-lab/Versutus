import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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

test('an existing token survives a restart (new store over the same file)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-tokens-'));
  const path = join(dir, 'tokens.json');
  const first = new TokenStore(path);
  const token = await first.ensureToken();

  const second = new TokenStore(path);
  assert.equal(await second.ensureToken(), token);
  assert.equal(await second.verify(`Bearer ${token}`), true);
});

test('a corrupt file is moved aside and a new token is minted loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-tokens-'));
  const path = join(dir, 'tokens.json');
  await writeFile(path, '{ not json', 'utf8');

  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  let tokens;
  try {
    tokens = new TokenStore(path);
    const minted = await tokens.ensureToken();
    assert.ok(minted.length >= 32);
  } finally {
    console.error = originalError;
  }

  const files = await readdir(dir);
  const backup = files.find((name) => name.startsWith('tokens.json.corrupt-'));
  assert.ok(backup, 'the corrupt file must be copied aside');
  assert.equal(await readFile(join(dir, backup), 'utf8'), '{ not json');
  assert.ok(errors.some((line) => line.includes('unreadable')), 'the failure must be logged loudly');

  // The minted token verifies, and the file on disk is valid JSON again.
  assert.equal(await tokens.verify(`Bearer ${(await tokens.ensureToken())}`), true);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(typeof stored.token, 'string');
});

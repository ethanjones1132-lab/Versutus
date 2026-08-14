import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setSecret, getSecret, useCredentialBackend } from '../core/capabilities/secrets.mjs';

function memoryBackend() {
  return {
    async protect(plain) {
      return Buffer.from(JSON.stringify({ data: Buffer.from(plain).toString('base64') }));
    },
    async unprotect(cipher) {
      const parsed = JSON.parse(Buffer.from(cipher).toString('utf8'));
      return Buffer.from(parsed.data, 'base64');
    },
  };
}

useCredentialBackend(memoryBackend());

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'gate-secrets-'));
}

test('round-trips a secret value', async () => {
  const root = await tempRoot();
  await setSecret(root, 'MY_KEY', 'sk-live-abc123');
  assert.equal(await getSecret(root, 'MY_KEY'), 'sk-live-abc123');
});

test('returns undefined for a refName that was never set', async () => {
  const root = await tempRoot();
  await setSecret(root, 'SOMETHING_ELSE', 'x');
  assert.equal(await getSecret(root, 'NEVER_SET'), undefined);
});

test('returns undefined when no secrets have ever been set in this root', async () => {
  const root = await tempRoot();
  assert.equal(await getSecret(root, 'ANYTHING'), undefined);
});

test('new writes go to the credential vault, not the co-located AES store', async () => {
  const root = await tempRoot();
  await setSecret(root, 'A', 'value-a');
  await setSecret(root, 'B', 'value-b');
  const files = await readdir(join(root, 'credentials'));
  assert.ok(files.some((name) => name.endsWith('.dpapi')));
  await assert.rejects(readFile(join(root, 'secrets', '.key')));
  assert.equal(await getSecret(root, 'A'), 'value-a');
  assert.equal(await getSecret(root, 'B'), 'value-b');
});

test('the stored value is not plaintext on disk', async () => {
  const root = await tempRoot();
  await setSecret(root, 'SECRET_NAME', 'sk-super-secret-value');
  const files = await readdir(join(root, 'credentials'));
  const raw = await readFile(join(root, 'credentials', files[0]));
  assert.equal(raw.toString('utf8').includes('sk-super-secret-value'), false);
});

test('different refNames do not collide', async () => {
  const root = await tempRoot();
  await setSecret(root, 'ONE', 'value-one');
  await setSecret(root, 'TWO', 'value-two');
  assert.equal(await getSecret(root, 'ONE'), 'value-one');
  assert.equal(await getSecret(root, 'TWO'), 'value-two');
});

test('overwriting a refName replaces the old value', async () => {
  const root = await tempRoot();
  await setSecret(root, 'KEY', 'old-value');
  await setSecret(root, 'KEY', 'new-value');
  assert.equal(await getSecret(root, 'KEY'), 'new-value');
});

test('concurrent setSecret calls do not lose data (serialized writes)', async () => {
  const root = await tempRoot();
  await Promise.all([
    setSecret(root, 'A', 'value-a'),
    setSecret(root, 'B', 'value-b'),
    setSecret(root, 'C', 'value-c'),
  ]);
  assert.equal(await getSecret(root, 'A'), 'value-a');
  assert.equal(await getSecret(root, 'B'), 'value-b');
  assert.equal(await getSecret(root, 'C'), 'value-c');
});

test('refName "__proto__" round-trips correctly', async () => {
  const root = await tempRoot();
  await setSecret(root, '__proto__', 'proto-value');
  assert.equal(await getSecret(root, '__proto__'), 'proto-value');
});

test('concurrent getSecret calls never throw or return undefined for a set refName', async () => {
  const root = await tempRoot();
  await setSecret(root, 'STABLE', 'stable-value');
  // Fire many concurrent reads to ensure serialization protects against read-during-write races
  const results = await Promise.all(
    Array.from({ length: 20 }, () => getSecret(root, 'STABLE'))
  );
  for (const result of results) {
    assert.equal(result, 'stable-value');
  }
});

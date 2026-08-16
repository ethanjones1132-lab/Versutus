import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialVault } from '../core/credentials/vault.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function memoryBackend(user = 'current') {
  return {
    async protect(plain) {
      return Buffer.from(JSON.stringify({
        user,
        data: Buffer.from(plain).toString('base64'),
      }));
    },
    async unprotect(cipher) {
      const parsed = JSON.parse(Buffer.from(cipher).toString('utf8'));
      if (parsed.user !== user) {
        throw new Error('wrong user');
      }
      return Buffer.from(parsed.data, 'base64');
    },
  };
}

async function vaultFor(user = 'current') {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-vault-'));
  roots.push(gateHome);
  return { gateHome, vault: new CredentialVault({ gateHome, backend: memoryBackend(user) }) };
}

test('vault status never returns the value', async () => {
  const { vault } = await vaultFor();
  await vault.set('provider/openai/api-key', 'secret-value');
  assert.deepEqual(await vault.describe('provider/openai/api-key'), { present: true });
});

test('round-trips a credential and deletes it', async () => {
  const { vault } = await vaultFor();
  await vault.set('provider/openai/api-key', 'secret-value');
  assert.equal(await vault.get('provider/openai/api-key'), 'secret-value');
  assert.equal(await vault.has('provider/openai/api-key'), true);
  await vault.delete('provider/openai/api-key');
  assert.equal(await vault.has('provider/openai/api-key'), false);
  assert.equal(await vault.get('provider/openai/api-key'), undefined);
});

test('tampered ciphertext fails closed', async () => {
  const { vault, gateHome } = await vaultFor();
  await vault.set('provider/openai/api-key', 'secret-value');
  const filePath = join(gateHome, 'credentials', 'provider-openai-api-key.dpapi');
  const raw = await readFile(filePath);
  raw[0] = raw[0] ^ 0xff;
  await writeFile(filePath, raw);
  await assert.rejects(() => vault.get('provider/openai/api-key'));
});

test('concurrent writes persist every value', async () => {
  const { vault } = await vaultFor();
  await Promise.all([
    vault.set('provider/a/api-key', 'value-a'),
    vault.set('provider/b/api-key', 'value-b'),
    vault.set('provider/c/api-key', 'value-c'),
  ]);
  assert.equal(await vault.get('provider/a/api-key'), 'value-a');
  assert.equal(await vault.get('provider/b/api-key'), 'value-b');
  assert.equal(await vault.get('provider/c/api-key'), 'value-c');
});

test('wrong-user unprotect fails closed without returning the value', async () => {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-vault-'));
  roots.push(gateHome);
  const writer = new CredentialVault({ gateHome, backend: memoryBackend('alice') });
  await writer.set('provider/openai/api-key', 'secret-value');
  const reader = new CredentialVault({ gateHome, backend: memoryBackend('bob') });
  await assert.rejects(() => reader.get('provider/openai/api-key'), /wrong user/i);
});

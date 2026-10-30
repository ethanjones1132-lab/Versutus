import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getSecret,
  listSecretNames,
  migrateLegacySecretsToVault,
  useCredentialBackend,
} from '../core/capabilities/secrets.mjs';

// Same in-memory backend as secrets.test.mjs: no DPAPI, no keychain, no network.
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
  return mkdtemp(join(tmpdir(), 'gate-legacy-secrets-'));
}

async function writeLegacyStore(root, contents) {
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'secrets', 'store.enc.json'), contents, 'utf8');
}

// The vault writes one file per ref, so an empty `credentials` directory (or
// none at all) means nothing was migrated.
async function migratedNothing(root) {
  try {
    return (await readdir(join(root, 'credentials'))).length === 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

const DAMAGED = /legacy secrets store .* is damaged/i;

test('a missing legacy store stays an empty store', async () => {
  const root = await tempRoot();
  assert.deepEqual(await listSecretNames(root), []);
  await migrateLegacySecretsToVault(root);
  assert.equal(await getSecret(root, 'ANY_REF'), undefined);
  assert.equal(await migratedNothing(root), true);
});

test('a truncated legacy store makes listing, migration and lookup reject', async () => {
  const root = await tempRoot();
  // Cut off mid-object, as a kill during an in-place write would leave it.
  await writeLegacyStore(root, '{"API_KEY":{"iv":"aa","tag":"bb","data":"cc"');
  await assert.rejects(listSecretNames(root), DAMAGED);
  await assert.rejects(migrateLegacySecretsToVault(root), DAMAGED);
  await assert.rejects(getSecret(root, 'API_KEY'), DAMAGED);
  assert.equal(await migratedNothing(root), true);
});

test('a valid empty legacy store stays an empty store', async () => {
  const root = await tempRoot();
  await writeLegacyStore(root, '{}\n');
  assert.deepEqual(await listSecretNames(root), []);
  await migrateLegacySecretsToVault(root);
  assert.equal(await getSecret(root, 'ANY_REF'), undefined);
  assert.equal(await migratedNothing(root), true);
});


test('damaged legacy store errors never echo the stored bytes', async () => {
  const root = await tempRoot();
  const marker = 'SYNTHETIC_CORRUPT_CONTENT';
  await writeLegacyStore(root, marker);
  for (const read of [
    () => listSecretNames(root),
    () => migrateLegacySecretsToVault(root),
    () => getSecret(root, 'ANY_REF'),
  ]) {
    await assert.rejects(read(), (error) => {
      assert.equal(error.code, 'legacy_secrets_store_unreadable');
      assert.match(error.message, DAMAGED);
      assert.equal(error.message.includes(marker), false);
      assert.equal(error.message.includes(marker.slice(0, 10)), false);
      return true;
    });
  }
});

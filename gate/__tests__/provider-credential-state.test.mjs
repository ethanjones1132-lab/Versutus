import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { classifyProviderError } from '../core/providers/errors.mjs';

// Two ways the Gate used to answer "can this provider be used?" wrongly.
//
// A migrated v1 provider keeps its key in an environment variable with no vault
// entry at all -- the adapter's own resolver knows that, and the readiness check
// did not, so the card said "Set key", the catalog was never fetched, and
// `/v1/models` lost the provider while chat against it worked.
//
// And `vault.has` is a file-existence check: a `.dpapi` blob written under
// another Windows account (or by a write that was killed) is present and
// useless, and its decrypt failure was classified as a transient network fault,
// so the record ended `auth: ready` + `readiness: degraded` with nothing telling
// the operator the stored key cannot be read here.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ENV_NAME = 'GATE_TEST_LEGACY_PROVIDER_KEY';

const acmeConfig = {
  schemaVersion: 2,
  kind: 'provider',
  id: 'acme',
  label: 'Acme',
  providerType: 'openai-compatible',
  enabled: true,
  registration: {
    mode: 'api_key',
    protocol: 'openai_chat',
    baseUrl: 'https://api.acme.invalid/v1',
    credentialRef: 'provider/acme/api-key',
  },
  catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
  requestPolicy: { timeoutMs: 120000 },
};

async function makeService({ state = {}, vault } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-credential-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  await store.put(acmeConfig, state);
  const calls = { probes: 0, listModels: 0 };
  const service = new ProviderService({
    store,
    vault,
    adapters: {
      acme: {
        authenticate: async () => {
          calls.probes += 1;
          return { state: 'ready' };
        },
        health: async () => {
          calls.probes += 1;
          return { state: 'ready' };
        },
        listModels: async () => {
          calls.listModels += 1;
          return [{ providerId: 'acme', id: 'env-model', available: true }];
        },
        chat: async () => ({ choices: [] }),
      },
    },
  });
  return { service, store, calls };
}

test('a key that lives in the environment counts as present, as the adapter does', async () => {
  process.env[ENV_NAME] = 'xai-the-real-key';
  try {
    const { service, calls } = await makeService({
      state: { legacyApiKeyEnv: ENV_NAME },
      vault: { has: async () => false, get: async () => undefined },
    });

    const checked = await service.check('acme');
    assert.equal(checked.auth.state, 'ready', 'a working provider was reported as missing');
    assert.equal(checked.readiness.state, 'ready');

    const refreshed = await service.refreshCatalog('acme', { force: true });
    assert.deepEqual(refreshed.catalog.models.map((model) => model.id), ['env-model']);
    assert.equal(calls.listModels, 1, 'the catalog was never fetched for an env-credential provider');
  } finally {
    delete process.env[ENV_NAME];
  }
});

test('a named environment variable that is not set is still missing', async () => {
  delete process.env[ENV_NAME];
  const { service } = await makeService({
    state: { legacyApiKeyEnv: ENV_NAME },
    vault: { has: async () => false, get: async () => undefined },
  });

  const checked = await service.check('acme');
  assert.equal(checked.auth.state, 'missing');
  assert.equal(checked.readiness.code, 'missing_credentials');
});

test('a credential that cannot be decrypted is named, not filed as a network fault', async () => {
  const { service, calls } = await makeService({
    vault: {
      has: async () => true,
      get: async () => undefined,
      inspect: async () => ({
        present: true,
        readable: false,
        error: { code: 'credential_unreadable', message: 'DPAPI unprotect failed: bad signature' },
      }),
    },
  });

  const checked = await service.check('acme');
  assert.equal(checked.auth.state, 'missing', 'the remedy is "Set key", not "Sign in again"');
  assert.equal(checked.readiness.state, 'unavailable');
  assert.equal(checked.readiness.code, 'credential_unreadable');
  assert.match(checked.readiness.message, /set the key again/i);
  assert.equal(calls.probes, 0, 'an unreadable credential must not be taken to the vendor');
  assert.equal(calls.listModels, 0);
});

test('the unreadable-credential code survives classification', () => {
  assert.equal(
    classifyProviderError({ code: 'credential_unreadable', message: 'DPAPI unprotect failed' }),
    'credential_unreadable',
  );
});
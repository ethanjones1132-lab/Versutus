import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registration(baseUrl) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id: 'acme',
    label: 'Acme',
    providerType: 'openai',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl,
      credentialRef: 'provider/acme/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

/**
 * The adapter closes over baseUrl and credential at construction. Caching it by
 * id with no invalidation means an edited provider keeps talking to the old
 * endpoint with the old key until the Gate restarts — an edit that appears to
 * save and then silently does nothing.
 */
async function makeService() {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-adapter-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  const builtWith = [];
  const service = new ProviderService({
    store,
    vault: { has: async () => true, get: async () => 'key', set: async () => {}, delete: async () => {} },
    createAdapter: (config) => {
      builtWith.push(config.registration.baseUrl);
      return {
        authenticate: async () => ({ state: 'ready' }),
        health: async () => ({ state: 'ready' }),
        listModels: async () => [],
        chat: async () => ({}),
      };
    },
  });
  return { service, builtWith };
}

test('editing a provider rebuilds its adapter against the new registration', async () => {
  const { service, builtWith } = await makeService();
  await service.create(registration('https://old.example/v1'));
  await service.check('acme');
  assert.deepEqual(builtWith, ['https://old.example/v1']);

  await service.update('acme', {
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: 'https://new.example/v1',
      credentialRef: 'provider/acme/api-key',
    },
  });
  await service.check('acme');

  assert.deepEqual(
    builtWith,
    ['https://old.example/v1', 'https://new.example/v1'],
    'the second check reused the adapter built from the old base URL',
  );
});

test('a rotated credential rebuilds the adapter', async () => {
  const { service, builtWith } = await makeService();
  await service.create(registration('https://old.example/v1'));
  await service.check('acme');
  service.forgetAdapter('acme');
  await service.check('acme');
  assert.equal(builtWith.length, 2, 'forgetAdapter should force a rebuild on next use');
});

test('deleting a provider drops its cached adapter', async () => {
  const { service, builtWith } = await makeService();
  await service.create(registration('https://old.example/v1'));
  await service.check('acme');
  await service.delete('acme');
  await service.create(registration('https://old.example/v1'));
  await service.check('acme');
  assert.equal(builtWith.length, 2, 'a recreated provider must not inherit the deleted adapter');
});

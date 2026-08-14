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

const nvidiaConfig = {
  schemaVersion: 2,
  kind: 'provider',
  id: 'nvidia',
  label: 'NVIDIA NIM',
  providerType: 'nvidia-nim',
  enabled: true,
  registration: {
    mode: 'api_key',
    protocol: 'openai_chat',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    credentialRef: 'provider/nvidia/api-key',
  },
  catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
  requestPolicy: { timeoutMs: 120000 },
};

function lkgState() {
  return {
    catalog: {
      source: 'last_known_good',
      state: 'stale',
      generation: 1,
      observedAt: '2026-01-01T00:00:00.000Z',
      models: [{ providerId: 'nvidia', id: 'meta/llama-3.1-8b-instruct', available: true }],
    },
  };
}

async function makeService({ adapter = {}, vault = { has: async () => true, get: async () => 'k' }, enabled = true } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-svc-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  await store.put({ ...nvidiaConfig, enabled }, lkgState());
  const service = new ProviderService({
    store,
    vault,
    adapters: {
      nvidia: {
        authenticate: async () => ({ state: 'ready' }),
        health: async () => ({ state: 'ready' }),
        listModels: async () => [{ providerId: 'nvidia', id: 'meta/llama-3.1-8b-instruct', available: true }],
        chat: async () => ({ choices: [] }),
        disconnect: async () => {},
        ...adapter,
      },
    },
  });
  return service;
}

test('catalog failure yields degraded provider with visible LKG provenance', async () => {
  const service = await makeService({
    adapter: {
      listModels: async () => {
        const error = new Error('catalog timeout');
        error.code = 'catalog_timeout';
        throw error;
      },
    },
  });
  const snapshot = await service.refreshCatalog('nvidia');
  assert.equal(snapshot.readiness.state, 'degraded');
  assert.equal(snapshot.catalog.source, 'last_known_good');
  assert.equal(snapshot.catalog.state, 'stale');
});

test('missing credentials make the provider unavailable', async () => {
  const service = await makeService({
    vault: { has: async () => false, get: async () => undefined },
  });
  const snapshot = await service.check('nvidia');
  assert.equal(snapshot.auth.state, 'missing');
  assert.equal(snapshot.readiness.state, 'unavailable');
  assert.equal(snapshot.readiness.code, 'missing_credentials');
});

test('refreshCatalog skips the adapter while the live catalog is within TTL', async () => {
  let calls = 0;
  const service = await makeService({
    adapter: {
      listModels: async () => {
        calls += 1;
        return [{ providerId: 'nvidia', id: 'live-model', available: true }];
      },
    },
  });
  await service.store.put(nvidiaConfig, {
    catalog: {
      source: 'live',
      state: 'fresh',
      generation: 3,
      observedAt: new Date().toISOString(),
      models: [{ providerId: 'nvidia', id: 'live-model', available: true }],
    },
  });
  const snapshot = await service.refreshCatalog('nvidia');
  assert.equal(calls, 0);
  assert.equal(snapshot.catalog.source, 'live');
  assert.equal(snapshot.catalog.state, 'fresh');
});

test('disabled providers are not treated as ready because Gate is healthy', async () => {
  const service = await makeService({ enabled: false });
  const snapshot = await service.check('nvidia');
  assert.equal(snapshot.readiness.state, 'disabled');
  assert.equal(snapshot.readiness.code, 'disabled');
});

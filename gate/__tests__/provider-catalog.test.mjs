import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyCatalogResult, isCatalogFresh, nextBackoff } from '../core/providers/catalog.mjs';
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

async function makeService(adapter, config = nvidiaConfig) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-catalog-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  await store.put({ ...config }, lkgState());
  const service = new ProviderService({
    store,
    vault: { has: async () => true, get: async () => 'k' },
    adapters: { [config.id]: adapter },
  });
  return { service, store };
}

test('successful live list replaces LKG and marks the catalog fresh', () => {
  const next = applyCatalogResult({
    previous: { source: 'last_known_good', state: 'stale', generation: 1, models: [] },
    models: [{ providerId: 'nvidia', id: 'live-model', available: true }],
  });
  assert.equal(next.source, 'live');
  assert.equal(next.state, 'fresh');
  assert.equal(next.generation, 2);
  assert.equal(next.models[0].id, 'live-model');
});

test('fresh live catalogs are reused until TTL expires', () => {
  const now = Date.parse('2026-01-01T00:00:30.000Z');
  assert.equal(isCatalogFresh({
    source: 'live',
    state: 'fresh',
    observedAt: '2026-01-01T00:00:00.000Z',
  }, 300, now), true);
  assert.equal(isCatalogFresh({
    source: 'last_known_good',
    state: 'stale',
    observedAt: '2026-01-01T00:00:00.000Z',
  }, 300, now), false);
});

test('transient failures back off exponentially', () => {
  const first = nextBackoff(undefined, 1_000);
  const second = nextBackoff(first, first.nextRetryAt);
  assert.equal(first.failures, 1);
  assert.equal(first.nextRetryAt, 1_000 + 30_000);
  assert.equal(second.failures, 2);
  assert.equal(second.nextRetryAt - first.nextRetryAt, 60_000);
});

test('failure keeps last-known-good when the policy allows it', () => {
  const next = applyCatalogResult({
    previous: {
      source: 'live',
      state: 'fresh',
      generation: 4,
      models: [{ providerId: 'nvidia', id: 'kept', available: true }],
    },
    error: { code: 'catalog_timeout' },
    allowLastKnownGood: true,
  });
  assert.equal(next.source, 'last_known_good');
  assert.equal(next.state, 'stale');
  assert.equal(next.models[0].id, 'kept');
});

test('a delayed older refresh cannot overwrite a newer forced refresh with stale failure state', async () => {
  let calls = 0;
  const slow = new Promise((resolve) => setTimeout(resolve, 60));
  const { service, store } = await makeService({
    authenticate: async () => ({ state: 'ready' }),
    health: async () => ({ state: 'ready' }),
    listModels: async () => {
      calls += 1;
      if (calls === 1) {
        await slow;
        const error = new Error('catalog timeout');
        error.code = 'catalog_timeout';
        throw error;
      }
      return [{ providerId: 'nvidia', id: 'live-model', available: true }];
    },
    chat: async () => ({ choices: [] }),
    disconnect: async () => {},
  });
  const [first, second] = await Promise.all([
    service.refreshCatalog('nvidia', { force: true }),
    service.refreshCatalog('nvidia', { force: true }),
  ]);
  assert.equal(first.catalog.state, 'stale');
  assert.equal(second.catalog.source, 'live');
  assert.equal(second.catalog.state, 'fresh');
  const record = await store.get('nvidia');
  assert.equal(record.state.catalog.source, 'live');
  assert.equal(record.state.catalog.state, 'fresh');
  assert.equal(record.state.catalog.models[0].id, 'live-model');
  assert.equal(record.state.backoff, undefined);
});

test('serialized forced refreshes each re-read so catalog generations advance in start order', async () => {
  let calls = 0;
  const slow = new Promise((resolve) => setTimeout(resolve, 60));
  const { service, store } = await makeService({
    authenticate: async () => ({ state: 'ready' }),
    health: async () => ({ state: 'ready' }),
    listModels: async () => {
      calls += 1;
      if (calls === 1) await slow;
      return [{ providerId: 'nvidia', id: `model-${calls}`, available: true }];
    },
    chat: async () => ({ choices: [] }),
    disconnect: async () => {},
  });
  const [first, second] = await Promise.all([
    service.refreshCatalog('nvidia', { force: true }),
    service.refreshCatalog('nvidia', { force: true }),
  ]);
  assert.equal(first.catalog.generation, 2);
  assert.equal(second.catalog.generation, 3);
  assert.equal(second.catalog.models[0].id, 'model-2');
  const record = await store.get('nvidia');
  assert.equal(record.state.catalog.generation, 3);
  assert.equal(record.state.catalog.models[0].id, 'model-2');
});

test('one provider slow refresh does not block another provider catalog', async () => {
  let calls = 0;
  const slow = new Promise((resolve) => setTimeout(resolve, 80));
  const first = await makeService({
    authenticate: async () => ({ state: 'ready' }),
    health: async () => ({ state: 'ready' }),
    listModels: async () => {
      calls += 1;
      if (calls === 1) await slow;
      return [{ providerId: 'nvidia', id: 'first', available: true }];
    },
    chat: async () => ({ choices: [] }),
    disconnect: async () => {},
  });
  const second = await makeService({
    authenticate: async () => ({ state: 'ready' }),
    health: async () => ({ state: 'ready' }),
    listModels: async () => [{ providerId: 'other', id: 'fast', available: true }],
    chat: async () => ({ choices: [] }),
    disconnect: async () => {},
  }, { ...nvidiaConfig, id: 'other' });
  const pending = first.service.refreshCatalog('nvidia', { force: true });
  const fast = await second.service.refreshCatalog('other', { force: true });
  assert.equal(fast.catalog.state, 'fresh');
  assert.equal(fast.catalog.models[0].id, 'fast');
  await pending;
});

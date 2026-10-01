import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { createProviderRpc } from '../core/providers/rpc.mjs';

// "Refresh catalog" is the one control a user presses because they do not
// believe the Gate's answer -- and it reached the service with no `force`, so it
// was a silent no-op inside the 300s TTL or inside a failure backoff that grew
// to fifteen minutes. Nothing in the answer said so either: the sanitized
// snapshot had no backoff, so the card looked unchanged and simply ignored.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

async function makeRpc({ state, listModels, health } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-refresh-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  await store.put(acmeConfig, state ?? {});
  const calls = { listModels: 0, reloaded: 0 };
  const service = new ProviderService({
    store,
    vault: { has: async () => true, get: async () => 'k', set: async () => {}, delete: async () => {} },
    adapters: {
      acme: {
        authenticate: async () => ({ state: 'ready' }),
        health: health ?? (async () => ({ state: 'ready' })),
        listModels: listModels ?? (async () => {
          calls.listModels += 1;
          return [{ providerId: 'acme', id: 'fresh-model', available: true }];
        }),
        chat: async () => ({ choices: [] }),
      },
    },
  });
  const rpc = createProviderRpc({
    service,
    vault: { set: async () => {}, delete: async () => {} },
    onChanged: async () => {
      calls.reloaded += 1;
    },
  });
  return { rpc, service, store, calls };
}

function freshCatalogState() {
  return {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
    catalog: {
      source: 'live',
      state: 'fresh',
      generation: 2,
      observedAt: new Date().toISOString(),
      models: [{ providerId: 'acme', id: 'good-model', available: true }],
    },
  };
}

test('the refresh control asks the vendor again inside the catalog TTL', async () => {
  const { rpc, calls } = await makeRpc({ state: freshCatalogState() });

  const snapshot = await rpc['providers.catalog.refresh']({ id: 'acme' });

  assert.equal(calls.listModels, 1, 'the tap was swallowed by the TTL guard');
  assert.deepEqual(snapshot.catalog.models.map((model) => model.id), ['fresh-model']);
});

test('the refresh control asks the vendor again inside a failure backoff', async () => {
  const state = freshCatalogState();
  state.backoff = { failures: 3, nextRetryAt: Date.now() + 15 * 60_000 };
  const { rpc, calls } = await makeRpc({ state });

  const snapshot = await rpc['providers.catalog.refresh']({ id: 'acme' });

  assert.equal(calls.listModels, 1, 'the tap was swallowed by the backoff guard');
  assert.deepEqual(snapshot.catalog.models.map((model) => model.id), ['fresh-model']);
  assert.equal(snapshot.backoff, undefined, 'a successful refresh clears the backoff');
});

test('a sanitized snapshot carries the backoff only while one is running', async () => {
  const failing = await makeRpc({
    state: freshCatalogState(),
    listModels: async () => {
      const error = new Error('models request failed: 503');
      error.status = 503;
      throw error;
    },
  });
  const failed = await failing.rpc['providers.catalog.refresh']({ id: 'acme' });
  assert.ok(failed.backoff?.nextRetryAt, 'the client cannot explain the wait without it');
  assert.equal(typeof failed.backoff.nextRetryAt, 'number');

  const listed = await failing.rpc['providers.list']();
  assert.ok(listed.providers[0].backoff.nextRetryAt);

  const healthy = await makeRpc({ state: freshCatalogState() });
  assert.equal((await healthy.rpc['providers.get']({ id: 'acme' })).backoff, undefined);
});

test('editing the base URL drops the backoff the old endpoint earned', async () => {
  const state = freshCatalogState();
  state.backoff = { failures: 4, nextRetryAt: Date.now() + 15 * 60_000 };
  const { rpc, service } = await makeRpc({ state });

  await rpc['providers.update']({
    id: 'acme',
    registration: { ...acmeConfig.registration, baseUrl: 'https://api.acme-fixed.invalid/v1' },
  });

  const record = await service.store.get('acme');
  assert.equal(record.state.backoff, undefined, 'a fixed endpoint is still serving the old backoff');
  assert.equal(record.state.catalog.state, 'stale', 'the old catalog is still advertised as fresh');
});

test('a health check and a refresh both rebuild the manifest', async () => {
  const { rpc, calls } = await makeRpc({ state: freshCatalogState() });

  const checked = await rpc['providers.health.check']({ id: 'acme' });
  assert.equal(calls.reloaded, 1, 'a check changed readiness without rebuilding the manifest');
  assert.equal(checked.id, 'acme');
  assert.equal(checked.catalog.models[0].id, 'good-model');

  await rpc['providers.catalog.refresh']({ id: 'acme' });
  assert.equal(calls.reloaded, 2, 'a refresh changed the catalog without rebuilding the manifest');
});

test('a manifest rebuild that fails does not fail the call that asked for it', async () => {
  const { service } = await makeRpc({ state: freshCatalogState() });
  const failing = createProviderRpc({
    service,
    onChanged: async () => {
      throw new Error('registry unreadable');
    },
  });

  const snapshot = await failing['providers.health.check']({ id: 'acme' });
  assert.equal(snapshot.readiness.state, 'ready');
});

test('a vendor error that quotes the key is redacted before it reaches the phone', async () => {
  const secret = 'sk-live-0123456789abcdefghij';
  const { rpc, service } = await makeRpc({
    state: freshCatalogState(),
    health: async () => {
      throw Object.assign(new Error(`models request failed: 401 for Authorization: Bearer ${secret}`), {
        status: 401,
      });
    },
  });

  const snapshot = await rpc['providers.health.check']({ id: 'acme' });

  assert.equal(snapshot.readiness.code, 'invalid_credentials');
  assert.doesNotMatch(snapshot.readiness.message, new RegExp(secret));
  assert.match(snapshot.readiness.message, /\[redacted\]/);

  const rpcWithVault = createProviderRpc({
    service,
    vault: {
      set: async () => {
        throw new Error(`could not protect ${secret}`);
      },
    },
  });
  await assert.rejects(
    () => rpcWithVault['providers.auth.setApiKey']({ id: 'acme', value: secret }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});
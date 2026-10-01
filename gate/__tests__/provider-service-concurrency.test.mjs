import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

// A provider record has four writers -- a check, a catalog refresh, a chat
// outcome and an edit -- and every one of them reads a whole record, decides
// something and writes a whole record back. Under three separate queues (and
// none at all for the check) the writer that finished last won, even when its
// read was the oldest, so a failing turn's `needs_reauth` could be erased by a
// check that started before the turn and answered after it.

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

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A service whose vendor probe and whose model list can each be held open, so a
 * test can put a real commit between a read and its write.
 */
async function makeService({ probe } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-concurrency-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  await store.put(nvidiaConfig, {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: new Date().toISOString() },
    catalog: {
      source: 'live',
      state: 'fresh',
      generation: 3,
      observedAt: new Date().toISOString(),
      models: [{ providerId: 'nvidia', id: 'live-model', available: true }],
    },
  });
  const gate = { probes: 0, listModels: 0 };
  const adapter = {
    authenticate: async () => {
      gate.probes += 1;
      if (probe) await probe.promise;
      return { state: 'ready' };
    },
    health: async () => ({ state: 'ready' }),
    listModels: async () => {
      gate.listModels += 1;
      if (probe) await probe.promise;
      return [{ providerId: 'nvidia', id: 'live-model', available: true }];
    },
    chat: async () => ({ choices: [] }),
  };
  const service = new ProviderService({
    store,
    vault: { has: async () => true, get: async () => 'k', set: async () => {}, delete: async () => {} },
    adapters: { nvidia: adapter },
  });
  return { service, store, gate, probe };
}

function denied() {
  return Object.assign(new Error('chat failed: 401'), { status: 401 });
}

test('a failed turn that lands while a check is probing survives that check', async () => {
  const probe = deferred();
  const { service, store } = await makeService({ probe });

  const checking = service.check('nvidia');
  await service.noteChatOutcome('nvidia', denied());
  probe.release();
  await checking;

  const state = (await store.get('nvidia')).state;
  assert.equal(state.auth.state, 'needs_reauth', 'the stale check verdict overwrote the turn');
  assert.equal(state.readiness.code, 'invalid_credentials');
  assert.equal(state.lastError.code, 'invalid_credentials');
});

test('a failed turn that lands during a catalog refresh keeps both its verdict and the models', async () => {
  const probe = deferred();
  const { service, store } = await makeService({ probe });

  const refreshing = service.refreshCatalog('nvidia', { force: true });
  await service.noteChatOutcome('nvidia', denied());
  probe.release();
  await refreshing;

  const state = (await store.get('nvidia')).state;
  assert.equal(state.auth.state, 'needs_reauth');
  assert.equal(state.readiness.code, 'invalid_credentials');
  assert.equal(state.lastError.code, 'invalid_credentials');
  assert.deepEqual(state.catalog.models.map((model) => model.id), ['live-model']);
});

test('a check and a chat outcome in the other order still ends on the turn', async () => {
  const probe = deferred();
  const { service, store } = await makeService({ probe });

  const checking = service.check('nvidia');
  // Wait until the probe is actually out before the turn lands, so this is the
  // older-turn case rather than the older-check one above.
  await new Promise((resolve) => setTimeout(resolve, 10));
  probe.release();
  await checking;
  await service.noteChatOutcome('nvidia', denied());

  const state = (await store.get('nvidia')).state;
  assert.equal(state.auth.state, 'needs_reauth');
});

test('two overlapping checks ask the vendor once and answer the same thing', async () => {
  const probe = deferred();
  const { service, gate } = await makeService({ probe });

  const first = service.check('nvidia');
  const second = service.check('nvidia');
  probe.release();
  const [one, other] = await Promise.all([first, second]);

  assert.equal(gate.probes, 1, 'the second tap started a second probe');
  assert.deepEqual(other, one);
});

test('a successful turn on an already-ready provider reports no verdict change', async () => {
  const { service } = await makeService();
  const result = await service.noteChatOutcome('nvidia', null);
  assert.equal(result.changed, false, 'an unchanged verdict must not report churn');
  const failure = await service.noteChatOutcome('nvidia', denied());
  assert.equal(failure.changed, true);
});

test('a queue entry that throws does not poison the commits behind it', async () => {
  const { service, store } = await makeService();
  const originalPut = service.store.put.bind(service.store);
  let calls = 0;
  service.store.put = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('disk full');
    return originalPut(...args);
  };

  await assert.rejects(() => service.noteChatOutcome('nvidia', denied()));
  await service.noteChatOutcome('nvidia', denied());

  const state = (await store.get('nvidia')).state;
  assert.equal(state.auth.state, 'needs_reauth');
  assert.equal(state.lastError.code, 'invalid_credentials');
});

test('a probe that finishes after the provider was deleted does not bring it back', async () => {
  const probe = deferred();
  const { service, store } = await makeService({ probe });

  const checking = service.check('nvidia');
  await service.delete('nvidia');
  probe.release();
  await checking;

  assert.equal(await store.get('nvidia'), null, 'the check rewrote a record that was deleted');
  assert.deepEqual(await service.list(), []);
});
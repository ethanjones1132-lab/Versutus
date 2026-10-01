import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

// Disabling a provider only wrote `enabled: false`: the readiness it kept was
// whatever the last probe said (`ready`), and nothing on the chat path read
// `enabled` at all, so a disabled provider went on answering turns. Re-enabling
// had the mirror problem -- the card kept the stale `disabled` verdict.
//
// And a turn with no key behind it was sent anyway, as `Authorization: Bearer
// undefined`; the vendor's 401 came back and was recorded as `needs_reauth`,
// which offers "Sign in again" for a provider whose only remedy is a key.

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

async function makeService({ enabled = true, vault, state } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-disable-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  await store.put({ ...acmeConfig, enabled }, state ?? {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
    catalog: {
      source: 'live',
      state: 'fresh',
      generation: 2,
      observedAt: '2026-01-01T00:00:00.000Z',
      models: [{ providerId: 'acme', id: 'good-model', available: true }],
    },
  });
  const calls = { probes: 0, listModels: 0, chat: 0 };
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
          return [{ providerId: 'acme', id: 'fresh-model', available: true }];
        },
        chat: async () => {
          calls.chat += 1;
          return { choices: [] };
        },
      },
    },
  });
  return { service, store, calls };
}

const readyVault = { has: async () => true, get: async () => 'k', set: async () => {}, delete: async () => {} };
const emptyVault = { has: async () => false, get: async () => undefined, set: async () => {}, delete: async () => {} };

const turn = (id = 'acme') => ({
  providerId: id,
  model: 'good-model',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
});

test('disabling a provider marks it disabled at once, without asking the vendor', async () => {
  const { service, calls } = await makeService({ vault: readyVault });
  const snapshot = await service.update('acme', { enabled: false });

  assert.equal(snapshot.readiness.state, 'disabled', 'the card still claimed to be ready');
  assert.equal(snapshot.readiness.code, 'disabled');
  assert.equal(calls.probes, 0, 'disabling must not reach the vendor');
});

test('a disabled provider refuses a turn instead of sending it', async () => {
  const { service, store, calls } = await makeService({ vault: readyVault });
  await service.update('acme', { enabled: false });

  await assert.rejects(
    () => service.chat(turn()),
    (error) => {
      assert.equal(error.code, 'disabled');
      return true;
    },
  );
  assert.equal(calls.chat, 0);

  const state = (await store.get('acme')).state;
  assert.equal(state.auth.state, 'ready', 'a refused turn must not rewrite the credential state');
});

test('re-enabling clears the disabled verdict without claiming it is ready', async () => {
  const { service, calls } = await makeService({ vault: readyVault });
  await service.update('acme', { enabled: false });
  const snapshot = await service.update('acme', { enabled: true });

  // The app renders only these four states, and offers "Check" for anything that
  // is not ready -- so an unchecked provider must not claim to be ready.
  assert.notEqual(snapshot.readiness.state, 'disabled');
  assert.ok(['ready', 'degraded', 'unavailable'].includes(snapshot.readiness.state));
  assert.equal(snapshot.readiness.state, 'unavailable');
  assert.equal(calls.probes, 0, 're-enabling must not reach the vendor');
});

test('refreshing the catalog of a disabled provider keeps its model list', async () => {
  const { service, store, calls } = await makeService({ vault: readyVault });
  await service.update('acme', { enabled: false });

  const snapshot = await service.refreshCatalog('acme', { force: true });

  assert.equal(snapshot.readiness.state, 'disabled');
  assert.deepEqual(snapshot.catalog.models.map((model) => model.id), ['good-model']);
  assert.equal(snapshot.catalog.source, 'live');
  assert.equal(calls.listModels, 0);
  const state = (await store.get('acme')).state;
  assert.deepEqual(state.catalog.models.map((model) => model.id), ['good-model']);
});

test('a turn with no credential is refused before any request is sent', async () => {
  const { service, store, calls } = await makeService({ vault: emptyVault });
  const checked = await service.check('acme');
  assert.equal(checked.auth.state, 'missing');

  await assert.rejects(
    () => service.chat(turn()),
    (error) => {
      assert.equal(error.code, 'missing_credentials');
      // `classifyProviderError` reads status first, so a status here would be
      // reclassified as a vendor refusal.
      assert.equal(error.status, undefined);
      return true;
    },
  );
  assert.equal(calls.chat, 0, 'the vendor was asked with no credential');

  const state = (await store.get('acme')).state;
  assert.equal(state.auth.state, 'missing', 'an absent key was recorded as needing a sign-in');
  assert.notEqual(state.auth.state, 'needs_reauth');
});

test('a refused turn for a missing credential leaves readiness missing, not a sign-in', async () => {
  const { service } = await makeService({ vault: emptyVault });
  await service.check('acme');

  await service.noteChatOutcome('acme', Object.assign(new Error('no credential'), {
    code: 'missing_credentials',
  }));

  const state = await service.store.get('acme');
  assert.equal(state.state.auth.state, 'missing');
  assert.equal(state.state.readiness.code, 'missing_credentials');
});
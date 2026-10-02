import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialVault } from '../core/credentials/vault.mjs';
import { createProviderAdapter } from '../core/providers/factory.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { createProviderRpc } from '../core/providers/rpc.mjs';

// Three verdicts the Gate was holding about a credential it had just been given,
// or had just failed to read:
//
//  - `providers.auth.setApiKey` wrote the vault entry, rebuilt the adapter and
//    returned, so the stored `auth: missing` survived and the card read "Not
//    configured" / "Set key" for a provider that now has a key, and the backoff
//    the failures before the fix earned was still advertised as "retrying at ...".
//  - A passing `check` did not clear that backoff either -- only a successful
//    catalog refresh did, and the app's own key flow never calls one.
//  - An `oauth` registration was asked about `registration.oauthProfileId` while
//    `OAuthManager` writes `oauth/<providerId>`, so a signed-in provider read as
//    having no credential at all and its adapter was built with no token.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(prefix) {
  const gateHome = await mkdtemp(join(tmpdir(), prefix));
  roots.push(gateHome);
  return gateHome;
}

const passthroughBackend = {
  protect: async (plain) => Buffer.from(plain),
  unprotect: async (cipher) => Buffer.from(cipher),
};

const apiKeyConfig = {
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

const oauthConfig = {
  schemaVersion: 2,
  kind: 'provider',
  id: 'oidc',
  label: 'OIDC',
  providerType: 'openai-compatible',
  enabled: true,
  registration: {
    mode: 'oauth',
    protocol: 'openai_chat',
    resourceBaseUrl: 'https://api.oidc.invalid/v1',
    oauthProfileId: 'oidc-profile',
  },
  catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
  requestPolicy: { timeoutMs: 120000 },
};

/** A record as the failures that preceded a fix leave it. */
function failedState() {
  return {
    auth: { state: 'missing', credentialCustodian: 'gate' },
    readiness: { state: 'unavailable', code: 'missing_credentials', checkedAt: '2026-01-01T00:00:00.000Z' },
    lastError: { code: 'invalid_credentials', message: 'models request failed: 401' },
    backoff: { failures: 3, nextRetryAt: Date.now() + 15 * 60_000 },
    catalog: {
      source: 'live',
      state: 'stale',
      generation: 1,
      observedAt: '2026-01-01T00:00:00.000Z',
      models: [{ providerId: 'acme', id: 'old-model', available: true }],
    },
  };
}

async function makeRpc({ config = apiKeyConfig, state } = {}) {
  const gateHome = await tempHome('gate-credential-verdict-');
  const store = new ProviderStore(gateHome);
  await store.put(config, state ?? failedState());
  const calls = { set: [], reloaded: 0, authenticate: 0 };
  const vault = {
    set: async (ref, value) => { calls.set.push(ref); },
    delete: async () => {},
  };
  const service = new ProviderService({
    store,
    vault: { has: async () => true, get: async () => 'k', ...vault },
    adapters: {
      [config.id]: {
        authenticate: async () => { calls.authenticate += 1; return { state: 'ready' }; },
        health: async () => ({ state: 'ready' }),
        listModels: async () => [{ providerId: config.id, id: 'm', available: true }],
        chat: async () => ({ choices: [] }),
      },
    },
  });
  const rpc = createProviderRpc({
    service,
    vault,
    onChanged: async () => { calls.reloaded += 1; },
  });
  return { rpc, service, store, calls, gateHome };
}

test('setting the key moves the card off "Not configured" and reloads the manifest', async () => {
  const { rpc, service, calls } = await makeRpc();

  assert.deepEqual(calls.set, [], 'the vault was written before the test asked');
  const before = await service.get('acme');
  assert.equal(before.auth.state, 'missing', 'the premise: the card reads "Not configured"');

  await rpc['providers.auth.setApiKey']({ id: 'acme', value: 'sk-live-new' });

  const after = await service.get('acme');
  assert.equal(after.auth.state, 'ready', 'the stored verdict still says "Set key" for a provider that has a key');
  assert.equal(calls.reloaded, 1, 'the manifest still advertises the old verdict until the Gate restarts');
});

test('setting the key moves the card off "Sign in again"', async () => {
  const { rpc, service } = await makeRpc({
    state: {
      ...failedState(),
      auth: { state: 'needs_reauth', credentialCustodian: 'gate' },
      readiness: { state: 'unavailable', code: 'invalid_credentials', checkedAt: '2026-01-01T00:00:00.000Z' },
    },
  });

  const before = await service.get('acme');
  assert.equal(before.auth.state, 'needs_reauth', 'the premise: the card reads "Sign in again"');

  await rpc['providers.auth.setApiKey']({ id: 'acme', value: 'sk-live-new' });

  const after = await service.get('acme');
  assert.notEqual(after.auth.state, 'needs_reauth', 'a fresh key still asked the operator to sign in again');
  assert.notEqual(after.auth.state, 'missing');
});

test('setting the key drops the backoff the failures before it earned', async () => {
  const { rpc, service } = await makeRpc();

  const snapshot = await rpc['providers.list']();
  assert.ok(snapshot.providers[0].backoff?.nextRetryAt, 'the premise: the old backoff is advertised');

  await rpc['providers.auth.setApiKey']({ id: 'acme', value: 'sk-live-new' });

  const record = await service.store.get('acme');
  assert.equal(record.state.backoff, undefined, 'a fifteen minute wait survived a corrected key');
  assert.equal(record.state.lastError, undefined, 'and so did the error it was waiting out');
  const listed = await rpc['providers.list']();
  assert.equal(listed.providers[0].backoff, undefined, 'the client is still told "retrying at ..."');
});

test('a passing check drops the backoff its own failures earned', async () => {
  const { rpc, service } = await makeRpc();

  const snapshot = await rpc['providers.health.check']({ id: 'acme' });

  assert.equal(snapshot.readiness.state, 'ready');
  const record = await service.store.get('acme');
  assert.equal(record.state.backoff, undefined, 'a probe that passed is still serving the wait the failures asked for');
});

test('an unreadable state file does not rewrite the provider as having no credential', async () => {
  const gateHome = await tempHome('gate-state-unreadable-');
  const store = new ProviderStore(gateHome);
  await store.put(apiKeyConfig, {
    ...failedState(),
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
    legacyApiKeyEnv: 'ACME_KEY',
  });

  // The read that works first is what proves the record was real and its facts
  // were known, exactly as a Gate that had been running for a while would be.
  const healthy = await store.get('acme');
  assert.equal(healthy.state.auth.state, 'ready');

  // Then the state file becomes unreadable in the way a Windows sharing violation
  // or OneDrive makes it unreadable: it is there, and `readFile` refuses it.
  const statePath = join(gateHome, 'state', 'providers', 'acme.json');
  await rm(statePath, { force: true });
  await mkdir(statePath, { recursive: true });

  const record = await store.get('acme');
  assert.equal(record.state.auth?.state, 'ready', 'an unread state file invented auth: missing');
  assert.equal(record.state.legacyApiKeyEnv, 'ACME_KEY', 'and dropped the migrated env fallback with it');
  assert.deepEqual(
    record.state.catalog.models.map((model) => model.id),
    ['old-model'],
    'and emptied the model list the card was showing',
  );

  // A provider that has genuinely never been checked still reads as legacy.
  const fresh = await tempHome('gate-state-absent-');
  await mkdir(join(fresh, 'config', 'providers'), { recursive: true });
  await writeFile(join(fresh, 'config', 'providers', 'acme.json'), JSON.stringify(apiKeyConfig), 'utf8');
  const untouched = await new ProviderStore(fresh).get('acme');
  assert.deepEqual(untouched.state.catalog, {
    source: 'legacy_bootstrap',
    state: 'stale',
    generation: 0,
    models: [],
  });
});

test('an oauth provider is seen through the key its sign-in writes', async () => {
  const gateHome = await tempHome('gate-oauth-presence-');
  const store = new ProviderStore(gateHome);
  await store.put(oauthConfig, {});
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set('oauth/oidc', JSON.stringify({ accessToken: 'access-1' }));
  let authenticated = 0;
  const service = new ProviderService({
    store,
    vault,
    adapters: {
      oidc: {
        authenticate: async () => { authenticated += 1; return { state: 'ready' }; },
        health: async () => ({ state: 'ready' }),
        listModels: async () => [],
        chat: async () => ({ choices: [] }),
      },
    },
  });

  const snapshot = await service.check('oidc');

  assert.equal(authenticated, 1, 'the probe never reached the vendor: the token was invisible');
  assert.equal(snapshot.auth.state, 'ready');
});

test('an oauth provider sends the token its sign-in stored', async () => {
  const asked = [];
  const adapter = createProviderAdapter(oauthConfig, {
    vault: { get: async () => undefined, has: async () => false },
    store: { get: async () => null },
    oauth: {
      getAccess: async (providerId) => {
        asked.push(providerId);
        return `access-token-for-${providerId}`;
      },
    },
  });

  // `authenticate` is the profile's own check that it has something to send: it
  // throws `missing_credentials` for the adapter built with `Bearer undefined`,
  // which is what an oauth registration got on every turn.
  const authenticated = await adapter.authenticate();

  assert.deepEqual(authenticated, { state: 'ready' });
  assert.deepEqual(asked, ['oidc'], 'the adapter was built without the stored token');
});

test('a forced catalog refresh does not join a non-forced TTL wait', async () => {
  const { service, store } = await makeRpc({
    state: {
      auth: { state: 'ready', credentialCustodian: 'gate' },
      readiness: { state: 'ready', checkedAt: new Date().toISOString() },
      catalog: {
        source: 'live',
        state: 'fresh',
        generation: 2,
        observedAt: new Date().toISOString(),
        models: [{ providerId: 'acme', id: 'good-model', available: true }],
      },
    },
  });

  let probes = 0;
  service.adapters.acme.listModels = async () => {
    probes += 1;
    return [{ providerId: 'acme', id: 'forced-model', available: true }];
  };

  // Hold the non-forced call inside `require` so it is in flight before it
  // short-circuits on the TTL — the window a forced tap used to join.
  const realGet = store.get.bind(store);
  let releaseGet;
  let signalParked;
  const parked = new Promise((resolve) => { signalParked = resolve; });
  let delayed = false;
  store.get = async (id) => {
    if (!delayed) {
      delayed = true;
      signalParked();
      await new Promise((resolve) => { releaseGet = resolve; });
    }
    return realGet(id);
  };

  const nonForced = service.refreshCatalog('acme');
  await parked;
  const forced = service.refreshCatalog('acme', { force: true });
  releaseGet();

  await nonForced;
  const snapshot = await forced;
  assert.equal(probes, 1, 'the forced tap joined the TTL wait and never asked the vendor');
  assert.equal(snapshot.catalog.models[0].id, 'forced-model');
});

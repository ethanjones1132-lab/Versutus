import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { createProviderRpc } from '../core/providers/rpc.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

// The default vault backend is Windows DPAPI (it shells out to powershell.exe)
// and the macOS default reaches the login Keychain. These tests care about which
// refs a teardown clears, not about encryption at rest, so they use the
// passthrough backend the credential-resolution tests already use, inside a
// temp Gate home. Nothing outside that directory is read or written.

const passthroughBackend = {
  protect: async (buffer) => buffer,
  unprotect: async (buffer) => buffer,
};

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function apiKeyRegistration(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id: 'acme',
    label: 'Acme original',
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
    ...overrides,
  };
}

function localRegistration() {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id: 'echo',
    label: 'Echo',
    providerType: 'custom-local',
    enabled: true,
    registration: {
      mode: 'local_interface',
      protocol: 'versutus_provider_v1',
      manifestUrl: 'http://127.0.0.1:9/.well-known/provider.json',
      // The credential the local adapter sends, held in the Gate's vault
      // alongside the registration rather than by the external custodian.
      adapterCredentialRef: 'provider/echo/adapter-key',
      credentialCustodian: 'external',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

async function makeRpc({ config = apiKeyRegistration(), state = {}, oauth } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-honesty-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  const service = new ProviderService({ store, vault, oauth, createAdapter: () => ({}) });
  await store.put(config, state);
  const calls = { reloaded: 0 };
  const rpc = createProviderRpc({
    service,
    vault,
    oauth,
    onChanged: async () => {
      calls.reloaded += 1;
    },
  });
  return { rpc, service, store, vault, calls };
}

test('disconnecting a provider clears the verdict its credential earned', async () => {
  const { rpc, service, vault, calls } = await makeRpc({
    state: {
      auth: { state: 'ready', credentialCustodian: 'gate' },
      readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
      catalog: {
        source: 'live',
        state: 'fresh',
        generation: 4,
        models: [{ providerId: 'acme', id: 'kept-model', available: true }],
      },
      backoff: { failures: 2, nextRetryAt: Date.now() + 60_000 },
      lastError: { code: 'invalid_credentials', message: 'vendor said 401' },
    },
  });
  await vault.set('provider/acme/api-key', 'sk-test-key-000000');

  const result = await rpc['providers.auth.disconnect']({ id: 'acme' });

  // The RPC envelope existing clients read does not change.
  assert.deepEqual(result, { ok: true });
  assert.equal(
    await vault.has('provider/acme/api-key'),
    false,
    'the credential outlived the disconnect that claimed to remove it',
  );

  const snapshot = await service.get('acme');
  assert.equal(
    snapshot.auth.state,
    'missing',
    'a provider with no credential left still reported its auth as ready',
  );
  assert.equal(snapshot.readiness.state, 'unavailable', 'readiness kept the verdict of a removed credential');
  assert.equal(snapshot.readiness.code, 'missing_credentials');
  assert.equal(snapshot.backoff, undefined, 'the old failure backoff survived the disconnect');
  // What the vendor told us about the models is still true; only the credential
  // verdict was invalidated.
  assert.deepEqual(snapshot.catalog.models.map((model) => model.id), ['kept-model']);

  const record = await service.store.get('acme');
  assert.equal(record.state.lastError, undefined, 'the last vendor error outlived the credential it was about');
  assert.ok(calls.reloaded >= 1, 'the manifest still advertised the disconnected provider as ready');
});

test('disconnecting a local-interface provider removes the adapter credential too', async () => {
  const { rpc, service, vault } = await makeRpc({
    config: localRegistration(),
    state: {
      auth: { state: 'ready', credentialCustodian: 'external' },
      readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
    },
  });
  await vault.set('provider/echo/adapter-key', 'adapter-token-000000');

  await rpc['providers.auth.disconnect']({ id: 'echo' });

  assert.equal(
    await vault.has('provider/echo/adapter-key'),
    false,
    'the local adapter credential survived a disconnect',
  );
  const snapshot = await service.get('echo');
  // The external custodian still owns the provider's identity; only the verdict
  // that credential earned is gone.
  assert.equal(snapshot.auth.credentialCustodian, 'external');
  assert.notEqual(snapshot.readiness.state, 'ready', 'readiness still claims a cleared credential works');
});

test('deleting a local-interface provider removes its adapter credential', async () => {
  const { service, vault } = await makeRpc({ config: localRegistration() });
  await vault.set('provider/echo/adapter-key', 'adapter-token-000000');

  await service.delete('echo');

  assert.equal(
    await vault.has('provider/echo/adapter-key'),
    false,
    'the adapter credential outlived the provider it belonged to',
  );
  assert.equal(await service.store.get('echo'), null);
});

test('registering an id that already exists refuses instead of overwriting it', async () => {
  const { service } = await makeRpc({
    state: {
      auth: { state: 'ready', credentialCustodian: 'gate' },
      readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
      catalog: {
        source: 'live',
        state: 'fresh',
        generation: 7,
        models: [{ providerId: 'acme', id: 'kept-model', available: true }],
      },
    },
  });

  await assert.rejects(
    () => service.create(apiKeyRegistration({ label: 'Acme replacement' })),
    (error) => {
      assert.equal(error.code, 'provider_exists');
      assert.match(error.message, /acme/);
      return true;
    },
  );

  const snapshot = await service.get('acme');
  assert.equal(snapshot.label, 'Acme original', 'a second registration overwrote the existing provider');
  assert.equal(snapshot.catalog.source, 'live', 'a refused registration reset the existing catalog to bootstrap');
  assert.equal(snapshot.readiness.state, 'ready', 'a refused registration reset the existing verdict');
});

test('a new registration still succeeds and a duplicate is reported by code over RPC', async () => {
  const { rpc, service } = await makeRpc();

  const created = await rpc['providers.create'](apiKeyRegistration({ id: 'beta', label: 'Beta' }));
  assert.deepEqual(created, { ok: true });
  const beta = await service.get('beta');
  assert.equal(beta.id, 'beta');
  assert.equal(beta.catalog.state, 'unavailable', 'a new provider must start unchecked');

  await assert.rejects(
    () => rpc['providers.create'](apiKeyRegistration({ id: 'beta' })),
    (error) => {
      assert.equal(error.code, 'provider_exists');
      return true;
    },
  );
  assert.equal((await service.list()).length, 2, 'the refused registration removed or duplicated a provider');
});

// Review follow-up to the vault change: `vault.has` now throws `credential_unreadable`
// when it could not run the presence check, instead of answering `false`. The service
// asks it on every inspection and chat turn, so a refusal must come out as a named,
// unreadable credential and never as an exception. A NUL in the ref is refused by
// `access` before it touches the filesystem on every platform, a deterministic
// stand-in for EACCES/EPERM/EBUSY.
const REFUSED_REF = 'provider/acme/api\u0000key';

function registrationWithRef(credentialRef) {
  const base = apiKeyRegistration();
  return { ...base, registration: { ...base.registration, credentialRef } };
}

test('a presence check the vault could not run counts as present, not as an exception', async () => {
  const config = registrationWithRef(REFUSED_REF);
  const { service } = await makeRpc({ config });

  assert.equal(await service.credentialPresent(config, { state: {} }), true);
});

test('inspect names an unreadable credential instead of throwing', async () => {
  const config = registrationWithRef(REFUSED_REF);
  const { service } = await makeRpc({ config });

  const result = await service.inspect({ config, state: {} });

  assert.equal(result.error?.code, 'credential_unreadable');
});

test('credentialPresent still reports an absent credential as absent and a stored one as present', async () => {
  const config = registrationWithRef('provider/acme/api-key');
  const { service, vault } = await makeRpc({ config });

  assert.equal(await service.credentialPresent(config, { state: {} }), false);
  await vault.set('provider/acme/api-key', 'sk-test-key-000000');
  assert.equal(await service.credentialPresent(config, { state: {} }), true);
});

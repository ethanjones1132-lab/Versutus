import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registration(overrides = {}) {
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
      baseUrl: 'https://api.openai.com/v1',
      credentialRef: 'provider/acme/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
    ...overrides,
  };
}

async function makeService() {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-reg-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  const vault = new CredentialVault({ gateHome });
  const service = new ProviderService({ store, vault, createAdapter: () => ({}) });
  return { service, store, vault, gateHome };
}

test('deleting a provider also removes its vault credential', async () => {
  const { service, vault } = await makeService();
  await service.create(registration());
  await vault.set('provider/acme/api-key', 'sk-secret');
  assert.equal(await vault.has('provider/acme/api-key'), true);

  await service.delete('acme');

  assert.equal(
    await vault.has('provider/acme/api-key'),
    false,
    'credential outlived the provider it belonged to',
  );
});

test('a provider type with no matching profile is rejected at registration', async () => {
  const { service } = await makeService();
  await assert.rejects(
    () => service.create(registration({ id: 'opencode', providerType: 'opencode' })),
    (error) => {
      assert.match(error.message, /providerType/);
      // The operator needs to know what IS supported, not just that this isn't.
      assert.match(error.message, /nvidia-nim/);
      return true;
    },
  );
});

test('every shipped profile id is accepted as a provider type', async () => {
  const { service } = await makeService();
  for (const providerType of ['openai', 'anthropic', 'nvidia-nim', 'xai', 'openai-compatible']) {
    await service.create(registration({ id: `p-${providerType}`, providerType }));
  }
  const listed = await service.list();
  assert.equal(listed.length, 5);
});

test('local_interface providers are exempt from the profile check', async () => {
  const { service } = await makeService();
  // A local provider is reached through its own manifest, not a shipped profile.
  await service.create({
    schemaVersion: 2,
    kind: 'provider',
    id: 'local-thing',
    label: 'Local thing',
    providerType: 'custom-local',
    enabled: true,
    registration: {
      mode: 'local_interface',
      protocol: 'versutus_provider_v1',
      manifestUrl: 'http://127.0.0.1:9999/.well-known/provider.json',
      credentialCustodian: 'external',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  });
  assert.equal((await service.get('local-thing')).id, 'local-thing');
});

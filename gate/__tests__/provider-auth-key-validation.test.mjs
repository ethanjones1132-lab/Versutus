import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { createProviderRpc } from '../core/providers/rpc.mjs';

// `providers.auth.setApiKey` used to forward whatever a client sent straight to
// the vault. `vault.set` already refuses undefined/null, but everything else
// went through `String(value)`: a number became a credential, and '' or '   '
// became a credential the presence check called present, so the card said a key
// was set while every turn failed to authenticate with it.

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

test('setApiKey refuses a missing, non-string or blank value before the vault', async () => {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-api-key-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  await store.put(acmeConfig, {});

  const writes = [];
  const vault = {
    set: async (ref, value) => {
      writes.push({ ref, value });
    },
    delete: async () => {},
  };
  const service = new ProviderService({ store, vault });
  const rpc = createProviderRpc({ service, vault });

  for (const value of [undefined, null, 42, true, {}, '', '   ']) {
    await assert.rejects(
      () => rpc['providers.auth.setApiKey']({ id: 'acme', value }),
      (error) => {
        assert.match(error.message, /non-empty string/);
        assert.equal(error.code, 'credential_value_invalid');
        return true;
      },
      `value ${JSON.stringify(value)} was accepted`,
    );
  }

  assert.deepEqual(writes, [], 'a refused value reached the vault');
  assert.equal(
    (await store.get('acme')).state.auth,
    undefined,
    'a refused value moved the credential verdict',
  );

  // A real key still round-trips, and the verdict moves with it.
  await rpc['providers.auth.setApiKey']({ id: 'acme', value: 'sk-live-good' });
  assert.deepEqual(writes, [{ ref: 'provider/acme/api-key', value: 'sk-live-good' }]);
  assert.ok((await store.get('acme')).state.auth, 'a stored key left the verdict unset');
});

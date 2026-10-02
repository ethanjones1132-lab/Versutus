import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { CredentialVault } from '../core/credentials/vault.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { createProviderAdapter } from '../core/providers/factory.mjs';

// A `.dpapi` file the Gate cannot read is still a credential the Gate holds.
// `readThrough` caught both the stat and the read and answered `undefined`, the
// same answer as a file that was never written, so `inspect` reported
// `readable: true` and `service.unreadableCredential` — the one code that tells
// "present but unusable" from "absent" — could never fire for a read failure.
// The two consequences were a card that asked for a key it already had, and a
// turn that went out as `Bearer undefined` to be answered 401.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const passthroughBackend = {
  protect: async (buffer) => buffer,
  unprotect: async (buffer) => buffer,
};

const CREDENTIAL_REF = 'provider-zen-api-key';

function zenConfig(baseUrl) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id: 'zen',
    label: 'Zen',
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl,
      credentialRef: CREDENTIAL_REF,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

/**
 * A stored key this process cannot read.
 *
 * A Windows sharing violation (EPERM/EBUSY) cannot be produced from JS, so the
 * refusal is made the deterministic way: a directory stands where the blob is.
 * `access` still answers true and `stat` still succeeds; only the read is
 * refused — the same branch, on the real filesystem.
 */
async function withUnreadableCredential(baseUrl) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-unreadable-'));
  roots.push(gateHome);
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set(CREDENTIAL_REF, 'the-correct-key');
  const filePath = join(gateHome, 'credentials', `${CREDENTIAL_REF}.dpapi`);
  await rm(filePath, { force: true });
  await mkdir(filePath, { recursive: true });

  const store = new ProviderStore(gateHome);
  await store.put(zenConfig(baseUrl), { catalog: { source: 'legacy_bootstrap', state: 'stale', generation: 0, models: [] } });
  return { gateHome, vault, store, config: await store.get('zen').then((record) => record.config) };
}

test('a credential file that exists but cannot be read is not reported readable', async () => {
  const { vault } = await withUnreadableCredential('https://example.invalid/v1');

  // The presence answer is unchanged and still true: the file is there.
  assert.equal(await vault.has(CREDENTIAL_REF), true);
  const probe = await vault.inspect(CREDENTIAL_REF);
  assert.equal(probe.present, true);
  assert.equal(probe.readable, false);
  assert.ok(probe.error?.code, 'the refusal is named, not flattened to a missing file');
});

test('a check reports credential_unreadable, so the remedy is the key again', async () => {
  const { vault, store } = await withUnreadableCredential('https://example.invalid/v1');
  const service = new ProviderService({ store, vault, adapters: { zen: {} } });

  const snapshot = await service.check('zen');
  assert.equal(snapshot.readiness.code, 'credential_unreadable');
  // `authStateForCode` maps it to `missing` on purpose: the remedy for a key
  // this machine cannot read is to set it again, not to sign in again.
  assert.equal(snapshot.auth.state, 'missing');
});

test('a turn never leaves the Gate carrying an unread credential', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'never' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  let vault;
  let config;
  try {
    const prepared = await withUnreadableCredential(baseUrl);
    vault = prepared.vault;
    config = prepared.config;
    const adapter = createProviderAdapter(config, { vault, store: prepared.store });

    // Refused locally: the vendor's 401 is what used to drive this card to
    // "Sign in again" for a key that was correct all along.
    await assert.rejects(
      () => adapter.chat({ model: 'zen-1', messages: [{ role: 'user', content: 'hi' }] }),
      (error) => {
        assert.equal(error.code, 'credential_unreadable');
        return true;
      },
    );
    assert.deepEqual(seen, [], 'nothing was sent, so nothing could be seen');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

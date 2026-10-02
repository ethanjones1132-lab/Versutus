import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

// `ProviderStore.list()` answered `[]` for a `readdir` that failed, with no log
// of any kind — while the per-file reads either side of it were retried five
// times over the transient codes and named anything still unreadable. So one
// refused directory read published "you have no providers": the manifest
// advertised no models and `GET /v1/providers` answered 200 with an empty array.

const passthroughBackend = {
  protect: async (buffer) => buffer,
  unprotect: async (buffer) => buffer,
};

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(prefix) {
  const gateHome = await mkdtemp(join(tmpdir(), prefix));
  roots.push(gateHome);
  return gateHome;
}

async function providerConfig(id) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id,
    label: id,
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: `https://${id}.invalid/v1`,
      credentialRef: `provider/${id}/api-key`,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

test('a store whose provider directory cannot be listed refuses rather than answering empty', async () => {
  const gateHome = await tempHome('gate-roster-store-');
  // A file where the directory belongs: `readdir` fails with ENOTDIR while the
  // shape of the failure is exactly the one a locked or network-backed gate home
  // produces — and, before the fix, was indistinguishable from "none".
  await mkdir(join(gateHome, 'config'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'providers'), 'not a directory', 'utf8');

  const service = new ProviderService({
    store: new ProviderStore(gateHome),
    vault: { has: async () => false, get: async () => undefined },
  });

  await assert.rejects(() => service.list(), (error) => {
    assert.equal(error.code, 'provider_roster_unreadable');
    assert.match(error.message, /ENOTDIR/);
    return true;
  });
});

test('the roster route reports the failed read instead of an empty roster', async () => {
  const root = await tempHome('gate-roster-');
  const gateHome = join(root, '.gate-home');
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  for (const id of ['one', 'two']) {
    await writeFile(join(gateHome, 'config', 'providers', `${id}.json`), JSON.stringify(await providerConfig(id)), 'utf8');
  }
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  const gate = await createGate({ root, port: 0, gateHome, vault });

  try {
    const auth = { headers: { Authorization: `Bearer ${gate.token}` } };
    const before = await (await fetch(`http://127.0.0.1:${gate.port}/v1/providers`, auth)).json();
    assert.equal(before.providers.length, 2);

    await rm(join(gateHome, 'config', 'providers'), { recursive: true, force: true });
    await writeFile(join(gateHome, 'config', 'providers'), 'not a directory', 'utf8');

    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/providers`, auth);
    assert.equal(response.status, 503, 'an unread roster is not an empty one');
    const body = await response.json();
    assert.equal(body.error.code, 'provider_roster_unreadable');
  } finally {
    await gate.close();
  }
});

test('an unreadable provider directory at start does not stop the Gate listening', async () => {
  const root = await tempHome('gate-roster-boot-');
  const gateHome = join(root, '.gate-home');
  // The same shape the route test uses after start: `config/providers` is a
  // file, so `readdir` is ENOTDIR. Throwing that out of `migrateLegacyProviders`
  // is how a OneDrive lock stopped `createGate` / `gate start` before listen.
  await mkdir(join(gateHome, 'config'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'providers'), 'not a directory', 'utf8');

  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  const gate = await createGate({ root, port: 0, gateHome, vault });

  try {
    assert.equal(typeof gate.port, 'number');
    assert.ok(gate.port > 0, 'createGate returned without listening');

    const auth = { headers: { Authorization: `Bearer ${gate.token}` } };
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/providers`, auth);
    assert.equal(response.status, 503, 'the roster read is still named after start');
    const body = await response.json();
    assert.equal(body.error.code, 'provider_roster_unreadable');
  } finally {
    await gate.close();
  }
});

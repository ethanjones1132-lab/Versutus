import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

// Readiness used to come only from `inspect`, which probes the catalog. For
// several providers that endpoint is free and answers 200 with no credits on
// the account -- so opencode-zen advertised `ready` while every chat 401'd with
// "Insufficient balance". Listing models is not what a provider is for.

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeService() {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-readiness-'));
  roots.push(gateHome);
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(
    join(gateHome, 'config', 'providers', 'zen.json'),
    JSON.stringify({
      schemaVersion: 2, kind: 'provider', id: 'zen', label: 'Zen',
      providerType: 'openai-compatible', enabled: true,
      registration: {
        mode: 'api_key', protocol: 'openai_chat',
        baseUrl: 'https://example.invalid/v1', credentialRef: 'provider/zen/api-key',
      },
      catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
      requestPolicy: { timeoutMs: 120000 },
    }),
    'utf8',
  );
  const store = new ProviderStore(gateHome);
  await store.put(
    (await store.get('zen')).config,
    { auth: { state: 'ready' }, readiness: { state: 'ready', checkedAt: new Date().toISOString() } },
  );
  return new ProviderService({ store, vault: { get: async () => 'k', set: async () => {}, delete: async () => {} } });
}

test('a 401 from a real chat turns a "ready" provider unavailable', async () => {
  const service = await makeService();
  assert.equal((await service.store.get('zen')).state.readiness.state, 'ready');

  const error = new Error('chat failed: 401');
  error.status = 401;
  await service.noteChatOutcome('zen', error);

  const after = (await service.store.get('zen')).state;
  assert.equal(after.readiness.state, 'unavailable');
  assert.equal(after.readiness.code, 'invalid_credentials');
  assert.equal(after.auth.state, 'needs_reauth');
  assert.match(after.lastError.message, /401/);
});

test('a 429 degrades rather than marking the provider dead', async () => {
  const service = await makeService();
  const error = new Error('rate limited');
  error.status = 429;
  await service.noteChatOutcome('zen', error);

  const after = (await service.store.get('zen')).state;
  assert.equal(after.readiness.code, 'rate_limited');
  assert.notEqual(after.readiness.state, 'unavailable');
});

test('a successful turn clears a previous failure', async () => {
  const service = await makeService();
  const error = new Error('chat failed: 401');
  error.status = 401;
  await service.noteChatOutcome('zen', error);
  assert.equal((await service.store.get('zen')).state.readiness.state, 'unavailable');

  await service.noteChatOutcome('zen', null);

  const after = (await service.store.get('zen')).state;
  assert.equal(after.readiness.state, 'ready');
  assert.equal(after.auth.state, 'ready');
  assert.equal(after.lastError, undefined);
});

test('an unknown provider id is a no-op, never a throw', async () => {
  const service = await makeService();
  await service.noteChatOutcome('nope', new Error('x'));
});

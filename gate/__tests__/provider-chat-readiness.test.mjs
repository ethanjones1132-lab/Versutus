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

async function makeService({ models = [] } = {}) {
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
    {
      auth: { state: 'ready' },
      readiness: { state: 'ready', checkedAt: new Date().toISOString() },
      // What this provider carries is half of what tells a model-level 404
      // from the endpoint answering with one, so a test that means the former
      // has to put the model on the record first.
      catalog: {
        source: models.length ? 'live' : 'legacy_bootstrap',
        state: models.length ? 'fresh' : 'unavailable',
        generation: models.length ? 1 : 0,
        ...(models.length ? { observedAt: new Date().toISOString() } : {}),
        models,
      },
    },
  );
  return new ProviderService({ store, vault: { get: async () => 'k', set: async () => {}, delete: async () => {} } });
}

const LLAMA = { providerId: 'zen', id: 'llama-3.1-8b', label: 'Llama 3.1 8B', available: true };

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

test('a concurrent failure then success still ends ready, in call order', async () => {
  const service = await makeService();
  const failure = new Error('chat failed: 401');
  failure.status = 401;
  // Without per-provider ordering both outcomes read the same `ready` state:
  // the success takes the `already ready` early return and writes nothing,
  // so the slower failure write wins and the provider stays unavailable.
  await Promise.all([
    service.noteChatOutcome('zen', failure),
    service.noteChatOutcome('zen', null),
  ]);

  const after = (await service.store.get('zen')).state;
  assert.equal(after.readiness.state, 'ready');
  assert.equal(after.auth.state, 'ready');
  assert.equal(after.lastError, undefined);
});

test('a concurrent 401 then 429 preserves the re-auth need', async () => {
  const service = await makeService();
  const denied = new Error('chat failed: 401');
  denied.status = 401;
  const limited = new Error('rate limited');
  limited.status = 429;
  // Without ordering both outcomes read `auth: ready`: the 429 then writes
  // back `ready` and wipes the needs_reauth the 401 just established.
  await Promise.all([
    service.noteChatOutcome('zen', denied),
    service.noteChatOutcome('zen', limited),
  ]);

  const after = (await service.store.get('zen')).state;
  assert.equal(after.readiness.code, 'rate_limited');
  assert.notEqual(after.readiness.state, 'unavailable');
  assert.equal(after.auth.state, 'needs_reauth');
});

test('a chat 404 for a model the provider lists never reaches the card', async () => {
  // The requested model is on this provider's own catalog, so the 404 is the
  // vendor refusing that model -- a model it has since retired, as in the
  // NVIDIA case -- not the provider failing. The card keeps the verdict it
  // earned: a model this vendor will not serve is not evidence about it.
  const service = await makeService({ models: [LLAMA] });
  const missing = new Error('chat failed: 404 - model not found');
  missing.status = 404;
  missing.model = LLAMA.id;
  await service.noteChatOutcome('zen', missing);

  const after = (await service.store.get('zen')).state;
  // The turn is still recorded, but the provider keeps the verdict it earned.
  assert.equal(after.readiness.state, 'ready');
  assert.equal(after.readiness.code, undefined);
  assert.equal(after.auth.state, 'ready');
  assert.equal(after.lastError, undefined);
  assert.equal(after.lastChatOutcome.ok, false);
});

test('a model-scoped 404 named only in the vendor body leaves the card alone', async () => {
  // No requested model on the error: the vendor's own explanation is the only
  // evidence, and it names a model this provider carries.
  const service = await makeService({ models: [LLAMA] });
  const vetoed = new Error(`chat failed: 404 — {"error":{"message":"The model '${LLAMA.id}' does not exist"}}`);
  vetoed.status = 404;
  await service.noteChatOutcome('zen', vetoed);

  const after = (await service.store.get('zen')).state;
  assert.equal(after.readiness.state, 'ready');
  assert.equal(after.auth.state, 'ready');
  assert.equal(after.lastError, undefined);
  assert.equal(after.lastChatOutcome.ok, false);
});

test('a 404 that names no model the provider lists is the endpoint answering', async () => {
  // A wrong base URL or chat path: nothing on the record names a model, so
  // there is no reason to read the 404 as a model verdict. The card has to say
  // the provider is failing, or the operator is never told the route is wrong.
  const service = await makeService();
  const wrongRoute = new Error('chat failed: 404 — <html><body><h1>404 Not Found</h1></body></html>');
  wrongRoute.status = 404;
  await service.noteChatOutcome('zen', wrongRoute);

  const after = (await service.store.get('zen')).state;
  assert.notEqual(after.readiness.state, 'ready');
  assert.equal(after.readiness.code, 'transient_network');
  assert.equal(after.lastError.code, 'transient_network');
  assert.match(after.lastError.message, /404/);
  assert.equal(after.lastChatOutcome.ok, false);
});

test('a 404 naming a model this provider does not list is a provider fault', async () => {
  // The catalog is the record of what the provider carries. A 404 naming a
  // model outside it -- or a bare 404 beside a populated catalog -- is the
  // route answering, not that model being refused.
  const service = await makeService({ models: [LLAMA] });
  const elsewhere = new Error('chat failed: 404 — model "gpt-4o-mini" not found');
  elsewhere.status = 404;
  elsewhere.model = 'gpt-4o-mini';
  await service.noteChatOutcome('zen', elsewhere);

  const after = (await service.store.get('zen')).state;
  assert.notEqual(after.readiness.state, 'ready');
  assert.equal(after.lastError.code, 'transient_network');
});

test('a chat error carries the model the turn named, so a model-level 404 stays off the card', async () => {
  // The end-to-end shape: the adapter throws a bare 404, `ProviderService.chat`
  // records which model was asked for on the error, and the outcome classifier
  // reads that against the catalog.
  const service = await makeService({ models: [LLAMA] });
  service.adapters.zen = {
    chat: async () => {
      throw Object.assign(new Error('chat failed: 404'), { status: 404 });
    },
  };

  let caught;
  try {
    await service.chat({ providerId: 'zen', model: LLAMA.id, messages: [] });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.model, LLAMA.id);

  await service.noteChatOutcome('zen', caught);
  const after = (await service.store.get('zen')).state;
  assert.equal(after.readiness.state, 'ready');
  assert.equal(after.lastError, undefined);
});

test('a failed outcome never poisons the per-provider queue', async () => {
  const service = await makeService();
  const failure = new Error('chat failed: 401');
  failure.status = 401;
  const originalPut = service.store.put.bind(service.store);
  let calls = 0;
  service.store.put = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('disk full');
    return originalPut(...args);
  };
  await Promise.all([
    service.noteChatOutcome('zen', failure).catch(() => undefined),
    service.noteChatOutcome('zen', null),
  ]);

  const after = (await service.store.get('zen')).state;
  assert.equal(after.readiness.state, 'ready');
  assert.equal(after.auth.state, 'ready');
});

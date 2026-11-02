import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { createProviderAdapter } from '../core/providers/factory.mjs';

// A local adapter discovers its manifest in the constructor. The factory used to
// build one per method call, so every turn, health probe and model listing paid
// a manifest GET first. These tests use the real wrapper with a mocked fetch and
// a temporary store; nothing here talks to a server, vendor or vault.

const realFetch = globalThis.fetch;
const roots = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fake loopback provider whose manifest and endpoints are keyed by a generated
 * name. Each manifest gets its own paths so a request proves which registration
 * (and therefore which wrapper) produced it.
 */
function startFakeProvider() {
  const manifests = new Map();
  const discoveries = new Map();
  const requests = [];
  let next = 0;

  function addManifest({ failDiscoveries = 0 } = {}) {
    const name = `p${++next}`;
    const path = `/${name}.json`;
    manifests.set(path, {
      name,
      failDiscoveries,
      manifest: {
        spec: 'versutus-provider/v1',
        id: 'echo',
        label: 'Echo',
        protocols: ['openai_chat'],
        auth: { schemes: ['bearer'], credentialCustodian: 'external' },
        endpoints: {
          health: `/${name}/health`,
          models: `/${name}/models`,
          chat: `/${name}/chat`,
        },
      },
    });
    return `http://127.0.0.1:9${path}`;
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const path = url.pathname;
    requests.push({
      path,
      method: init.method ?? 'GET',
      authorization: init.headers?.authorization ?? init.headers?.Authorization ?? null,
    });

    const entry = manifests.get(path);
    if (entry) {
      discoveries.set(path, (discoveries.get(path) ?? 0) + 1);
      if (entry.failDiscoveries > 0) {
        entry.failDiscoveries -= 1;
        return jsonResponse({ error: 'still loading' }, 503);
      }
      return jsonResponse(entry.manifest);
    }

    const match = path.match(/^\/(p\d+)\/(health|models|chat)$/);
    if (!match) return jsonResponse({ error: `unexpected ${path}` }, 404);
    const [, name, endpoint] = match;
    if (endpoint === 'health') return jsonResponse({ status: 'ok' });
    if (endpoint === 'models') return jsonResponse({ data: [{ id: `${name}-model` }] });
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'pong' } }] });
  }

  function nameFor(manifestUrl) {
    return new URL(manifestUrl).pathname.replace(/^\//, '').replace(/\.json$/, '');
  }

  return {
    fetchImpl,
    addManifest,
    discoveriesFor(manifestUrl) {
      return discoveries.get(new URL(manifestUrl).pathname) ?? 0;
    },
    requestsFor(manifestUrl, endpoint) {
      return requests.filter((request) => request.path === `/${nameFor(manifestUrl)}/${endpoint}`);
    },
  };
}

function localRegistration(manifestUrl) {
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
      manifestUrl,
      adapterCredentialRef: 'provider/echo/adapter-key',
      credentialCustodian: 'external',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

async function makeService() {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-local-reuse-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  let credential = 'adapter-token-a';
  const vaultReads = [];
  const vault = {
    has: async () => true,
    get: async (ref) => {
      vaultReads.push(ref);
      return credential;
    },
    set: async () => {},
    delete: async () => {},
  };
  const service = new ProviderService({
    store,
    vault,
    createAdapter: (config) => createProviderAdapter(config, { vault, store }),
  });
  return {
    service,
    store,
    vaultReads,
    setCredential(value) {
      credential = value;
    },
  };
}

async function wrapperFor(service, store) {
  const record = await store.get('echo');
  return service.adapterFor('echo', record.config);
}

test('sequential local actions discover the manifest once and still run', async () => {
  const fake = startFakeProvider();
  globalThis.fetch = fake.fetchImpl;
  const manifestUrl = fake.addManifest();
  const { service, store, vaultReads } = await makeService();
  await service.create(localRegistration(manifestUrl));

  const adapter = await wrapperFor(service, store);
  assert.deepEqual(await adapter.authenticate(), { state: 'ready' });
  assert.deepEqual(await adapter.health(), { state: 'ready' });
  const models = await adapter.listModels();
  const chat = await adapter.chat({ model: 'echo-1', messages: [{ role: 'user', content: 'hi' }] });
  await adapter.disconnect();

  assert.equal(fake.discoveriesFor(manifestUrl), 1, 'each action discovered the manifest again');
  assert.equal(vaultReads.length, 1, 'the adapter credential was resolved once per wrapper');
  assert.deepEqual(models.map((model) => model.id), ['p1-model']);
  assert.equal(chat.choices[0].message.content, 'pong');
  assert.equal(fake.requestsFor(manifestUrl, 'health').length, 1);
  assert.equal(fake.requestsFor(manifestUrl, 'models').length, 1);
  assert.equal(fake.requestsFor(manifestUrl, 'chat').length, 1);
});

test('concurrent local actions share one discovery and still run', async () => {
  const fake = startFakeProvider();
  globalThis.fetch = fake.fetchImpl;
  const manifestUrl = fake.addManifest();
  const { service, store, vaultReads } = await makeService();
  await service.create(localRegistration(manifestUrl));

  const adapter = await wrapperFor(service, store);
  const [health, models, chat] = await Promise.all([
    adapter.health(),
    adapter.listModels(),
    adapter.chat({ model: 'echo-1', messages: [{ role: 'user', content: 'hi' }] }),
  ]);

  assert.equal(fake.discoveriesFor(manifestUrl), 1, 'concurrent callers raced separate discoveries');
  assert.equal(vaultReads.length, 1, 'concurrent callers resolved the credential more than once');
  assert.deepEqual(health, { state: 'ready' });
  assert.deepEqual(models.map((model) => model.id), ['p1-model']);
  assert.equal(chat.choices[0].message.content, 'pong');
  assert.equal(fake.requestsFor(manifestUrl, 'health').length, 1);
  assert.equal(fake.requestsFor(manifestUrl, 'models').length, 1);
  assert.equal(fake.requestsFor(manifestUrl, 'chat').length, 1);
});

test('a rejected discovery can be retried by the same wrapper', async () => {
  const fake = startFakeProvider();
  globalThis.fetch = fake.fetchImpl;
  const manifestUrl = fake.addManifest({ failDiscoveries: 1 });
  const { service, store } = await makeService();
  await service.create(localRegistration(manifestUrl));

  const adapter = await wrapperFor(service, store);
  await assert.rejects(() => adapter.health(), /manifest discovery failed: 503/);
  assert.equal(fake.discoveriesFor(manifestUrl), 1);

  assert.deepEqual(await adapter.health(), { state: 'ready' });
  assert.equal(fake.discoveriesFor(manifestUrl), 2, 'a rejected discovery was cached forever');
  assert.equal(
    fake.requestsFor(manifestUrl, 'health').length,
    1,
    'only the successful attempt should have run health',
  );
});

test('a new wrapper after a registration change discovers again and uses the new manifest', async () => {
  const fake = startFakeProvider();
  globalThis.fetch = fake.fetchImpl;
  const firstUrl = fake.addManifest();
  const secondUrl = fake.addManifest();
  const { service, store } = await makeService();
  await service.create(localRegistration(firstUrl));

  const first = await wrapperFor(service, store);
  assert.deepEqual((await first.listModels()).map((model) => model.id), ['p1-model']);

  await service.update('echo', { registration: localRegistration(secondUrl).registration });
  const second = await wrapperFor(service, store);
  assert.deepEqual((await second.listModels()).map((model) => model.id), ['p2-model']);

  assert.equal(fake.discoveriesFor(firstUrl), 1, 'the old wrapper discovered again after the edit');
  assert.equal(
    fake.discoveriesFor(secondUrl),
    1,
    'the new wrapper reused a discovery from the old registration',
  );
});

test('a new wrapper after a credential change discovers again and sends the new credential', async () => {
  const fake = startFakeProvider();
  globalThis.fetch = fake.fetchImpl;
  const manifestUrl = fake.addManifest();
  const { service, store, setCredential } = await makeService();
  await service.create(localRegistration(manifestUrl));

  const first = await wrapperFor(service, store);
  await first.health();
  assert.equal(fake.requestsFor(manifestUrl, 'health')[0].authorization, 'Bearer adapter-token-a');

  setCredential('adapter-token-b');
  // What a credential write does: the wrapper closes over the old credential.
  service.forgetAdapter('echo');
  const second = await wrapperFor(service, store);
  await second.health();

  assert.equal(fake.discoveriesFor(manifestUrl), 2, 'the new wrapper reused the old credential discovery');
  assert.equal(fake.requestsFor(manifestUrl, 'health')[1].authorization, 'Bearer adapter-token-b');
});

test('remote api_key wrappers still resolve their credential per operation', async () => {
  const seen = [];
  globalThis.fetch = async (_input, init = {}) => {
    seen.push(init.headers?.Authorization ?? init.headers?.authorization ?? null);
    return jsonResponse({ data: [{ id: 'remote-model' }] });
  };
  let credential = 'remote-key-1';
  const vault = { get: async () => credential };
  const adapter = createProviderAdapter({
    schemaVersion: 2,
    kind: 'provider',
    id: 'remote',
    label: 'Remote',
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: 'http://127.0.0.1:9/v1',
      credentialRef: 'provider/remote/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  }, { vault });

  await adapter.listModels();
  credential = 'remote-key-2';
  await adapter.listModels();

  assert.deepEqual(
    seen,
    ['Bearer remote-key-1', 'Bearer remote-key-2'],
    'the remote credential was cached across operations',
  );
});

test('oauth wrappers still refresh their token per operation', async () => {
  const seen = [];
  globalThis.fetch = async (_input, init = {}) => {
    seen.push(init.headers?.Authorization ?? init.headers?.authorization ?? null);
    return jsonResponse({ data: [{ id: 'remote-model' }] });
  };
  let calls = 0;
  const oauth = {
    getAccess: async (providerId, options) => {
      calls += 1;
      assert.equal(providerId, 'remote-oauth');
      assert.deepEqual(options, { oauthProfileId: 'openai' });
      return { accessToken: `oauth-token-${calls}` };
    },
  };
  const adapter = createProviderAdapter({
    schemaVersion: 2,
    kind: 'provider',
    id: 'remote-oauth',
    label: 'Remote OAuth',
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'oauth',
      protocol: 'openai_chat',
      resourceBaseUrl: 'http://127.0.0.1:9/v1',
      oauthProfileId: 'openai',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  }, { oauth });

  await adapter.listModels();
  await adapter.listModels();

  assert.deepEqual(
    seen,
    ['Bearer oauth-token-1', 'Bearer oauth-token-2'],
    'the oauth token was cached across operations',
  );
});

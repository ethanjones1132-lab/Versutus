import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { createProviderAdapter } from '../core/providers/factory.mjs';
import { startProviderStub } from './fixtures/provider-stub.mjs';

// A loopback provider that accepted the connection and then said nothing left
// `ManifestClient.fetchLimited` waiting forever: it passed no signal and set no
// timeout, and `readLimited` had no bound either. `service.check` parks that
// never-settling promise in `checkFlights` and only clears it in a `finally` that
// never runs -- so one "Check" tap wedged every later tap, from any phone, for
// the life of the Gate. The remote profiles were bounded for exactly this reason.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const BUDGET_MS = 80;

const localConfig = {
  schemaVersion: 2,
  kind: 'provider',
  id: 'echo',
  label: 'Echo',
  providerType: 'openai-compatible',
  enabled: true,
  registration: {
    mode: 'local_interface',
    protocol: 'versutus_provider_v1',
    manifestUrl: 'http://127.0.0.1:1/.well-known/versutus-provider.json',
    credentialCustodian: 'external',
  },
  catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
  requestPolicy: { timeoutMs: BUDGET_MS },
};

/** A real loopback server that accepts every connection and never answers. */
async function startSilentServer() {
  const sockets = [];
  const server = createServer(() => {});
  server.on('connection', (socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    manifestUrl: `http://127.0.0.1:${server.address().port}/.well-known/versutus-provider.json`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function serviceFor(manifestUrl) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-local-bound-'));
  roots.push(gateHome);
  const store = new ProviderStore(gateHome);
  const config = { ...localConfig, registration: { ...localConfig.registration, manifestUrl } };
  await store.put(config, { catalog: { source: 'legacy_bootstrap', state: 'stale', generation: 0, models: [] } });
  return new ProviderService({
    store,
    vault: { has: async () => true, get: async () => undefined },
    // The real factory, so the registration's own budget is read where the
    // remote path reads it and the adapter is the wrapper it actually is.
    createAdapter: (registration) => createProviderAdapter(registration, { store }),
  });
}

test('a local provider that never answers is reported, not waited on', async () => {
  const silent = await startSilentServer();
  try {
    const service = await serviceFor(silent.manifestUrl);
    const snapshot = await Promise.race([
      service.check('echo'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the check never settled')), 5000)),
    ]);
    assert.equal(snapshot.readiness.state, 'degraded');
    assert.equal(snapshot.readiness.code, 'transient_network');
  } finally {
    await silent.close();
  }
});

test('the first hung check does not wedge every later check on that provider', async () => {
  const silent = await startSilentServer();
  try {
    const service = await serviceFor(silent.manifestUrl);
    const settle = () => Promise.race([
      service.check('echo'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the check never settled')), 5000)),
    ]);
    await settle();
    // The flight map is the wedge: a second tap used to join the first promise
    // and wait on it forever, whatever the state of the provider.
    await settle();
    assert.equal(service.checkFlights.size, 0, 'the flight was left behind');
  } finally {
    await silent.close();
  }
});

/** Headers, then a first body byte, then silence — fetch has already resolved. */
async function startHeaderThenSilentServer() {
  const sockets = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  server.on('connection', (socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    manifestUrl: `http://127.0.0.1:${server.address().port}/.well-known/versutus-provider.json`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a local provider that sends headers and then stalls is reported, not waited on', async () => {
  const stalled = await startHeaderThenSilentServer();
  try {
    const service = await serviceFor(stalled.manifestUrl);
    const snapshot = await Promise.race([
      service.check('echo'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the body stall never settled')), 5000)),
    ]);
    assert.equal(snapshot.readiness.state, 'degraded');
    assert.equal(snapshot.readiness.code, 'transient_network');
    assert.equal(service.checkFlights.size, 0, 'the flight was left behind after headers arrived');
  } finally {
    await stalled.close();
  }
});

test('a hung local catalog refresh settles too, and leaves no flight behind', async () => {
  const silent = await startSilentServer();
  try {
    const service = await serviceFor(silent.manifestUrl);
    await Promise.race([
      service.refreshCatalog('echo', { force: true }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the refresh never settled')), 5000)),
    ]);
    assert.equal(service.refreshFlights.size, 0);
  } finally {
    await silent.close();
  }
});

test('a healthy local provider is unaffected by the bound', async () => {
  const stub = await startProviderStub();
  try {
    const service = await serviceFor(stub.manifestUrl);
    const snapshot = await service.check('echo');
    assert.equal(snapshot.auth.state, 'ready');
    assert.equal(snapshot.readiness.state, 'ready');
  } finally {
    await stub.close();
  }
});

/** A loopback provider that serves a manifest and refuses everything else, in words. */
async function startRefusingServer({ status = 503, body }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/.well-known/versutus-provider.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        spec: 'versutus-provider/v1',
        id: 'refuser',
        label: 'Refuser',
        protocols: ['openai_chat'],
        auth: { schemes: ['bearer'], credentialCustodian: 'external' },
        endpoints: { health: '/v1/health', models: '/v1/models', chat: '/v1/chat/completions' },
      }));
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    manifestUrl: `http://127.0.0.1:${server.address().port}/.well-known/versutus-provider.json`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a local refusal carries the provider\'s own explanation', async () => {
  const refuser = await startRefusingServer({
    status: 503,
    body: '{"error":"the model server is still loading its weights"}',
  });
  try {
    const { createLocalProviderAdapter } = await import('../core/providers/local/adapter.mjs');
    const adapter = await createLocalProviderAdapter({ manifestUrl: refuser.manifestUrl, providerId: 'refuser' });
    // Before the drain this was `local provider health failed: 503` with nothing
    // to say why, and the body was left holding the connection.
    await assert.rejects(() => adapter.health(), (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /still loading its weights/);
      return true;
    });
    await assert.rejects(() => adapter.listModels(), /still loading its weights/);
    await assert.rejects(() => adapter.chat({ model: 'm', messages: [] }), /still loading its weights/);
  } finally {
    await refuser.close();
  }
});

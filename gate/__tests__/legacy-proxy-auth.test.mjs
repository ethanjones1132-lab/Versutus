import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';
import { ProviderStore } from '../core/providers/store.mjs';

// The legacy fallback in `dispatchChat` (`proxyChat`) serves a provider whose
// v2 store record is gone but whose legacy registry file remains — exactly
// what an operator's `providers.delete` leaves behind, because the migration
// copies legacy files into the v2 store and never writes back. The flavor
// codecs deliberately emit no auth header (auth moved into provider profiles),
// so this path must put the apiKey it resolved onto the request itself or the
// vendor receives the operator's messages with no credential at all.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all([...new Set(roots.splice(0))].map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

/** A vendor the test controls: it records the auth headers the Gate sent. */
async function startVendor({ anthropic = false } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({
      authorization: req.headers.authorization ?? null,
      apiKey: req.headers['x-api-key'] ?? null,
    });
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(anthropic
      ? JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })
      : JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    seen,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A Gate with one legacy registry provider. Startup migrates it into the v2
 * store; deleting that record afterwards reproduces the operator-delete
 * residue — legacy twin in the manifest, no v2 record — which is the only
 * state in which `dispatchChat` routes to `proxyChat`.
 */
async function makeLegacyGate(upstreamBaseUrl, { flavor = 'openai', apiKeyEnv = 'LEGACY_PROXY_KEY' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-legacy-proxy-'));
  roots.push(root);
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(join(root, 'registry', 'stub.json'), JSON.stringify({
    kind: 'provider',
    label: 'Stub',
    config: {
      flavor,
      baseUrl: upstreamBaseUrl,
      apiKeyEnv,
      models: ['stub-1'],
    },
  }), 'utf8');
  process.env[apiKeyEnv] = 'legacy-key-for-tests';
  const gate = await createGate({ root, port: 0, voiceWarmStart: false });
  await new ProviderStore(join(root, '.gate-home')).delete('stub');
  let closed = false;
  return {
    gate,
    base: `http://127.0.0.1:${gate.port}`,
    close: () => (closed ? Promise.resolve() : (closed = true, gate.close())),
  };
}

const auth = (gate) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${gate.token}`,
});

test('the legacy proxy path sends the resolved apiKey as a bearer header', async () => {
  const vendor = await startVendor();
  const harness = await makeLegacyGate(vendor.baseUrl);
  try {
    const res = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(harness.gate),
      body: JSON.stringify({
        providerId: 'stub',
        model: 'stub-1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(vendor.seen.length, 1);
    assert.equal(vendor.seen[0].authorization, 'Bearer legacy-key-for-tests');
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('an anthropic-flavored legacy provider is authenticated with x-api-key', async () => {
  const vendor = await startVendor({ anthropic: true });
  const harness = await makeLegacyGate(vendor.baseUrl, { flavor: 'anthropic' });
  try {
    const res = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(harness.gate),
      body: JSON.stringify({
        providerId: 'stub',
        model: 'stub-1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(vendor.seen.length, 1);
    assert.equal(vendor.seen[0].apiKey, 'legacy-key-for-tests');
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('no apiKey configured means no auth header, as before', async () => {
  const vendor = await startVendor();
  const harness = await makeLegacyGate(vendor.baseUrl, { apiKeyEnv: 'LEGACY_PROXY_UNSET_KEY' });
  try {
    delete process.env.LEGACY_PROXY_UNSET_KEY;
    const res = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(harness.gate),
      body: JSON.stringify({
        providerId: 'stub',
        model: 'stub-1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(vendor.seen.length, 1);
    assert.equal(vendor.seen[0].authorization, null);
  } finally {
    await harness.close();
    await vendor.close();
  }
});

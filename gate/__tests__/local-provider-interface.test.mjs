import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { startProviderStub } from './fixtures/provider-stub.mjs';
import { ManifestClient } from '../core/providers/local/manifest-client.mjs';
import { createLocalProviderAdapter } from '../core/providers/local/adapter.mjs';
import { runConformance } from '../provider-sdk/conformance.mjs';

test('rejects a local provider manifest that redirects off loopback', async () => {
  const stub = await startProviderStub({ redirectWellKnown: 'https://example.com/steal' });
  after(() => stub.close());
  const client = new ManifestClient({ manifestUrl: stub.manifestUrl });
  await assert.rejects(() => client.discover(), /loopback|redirect/i);
});

test('rejects a non-loopback manifest URL before connecting', async () => {
  const client = new ManifestClient({ manifestUrl: 'https://evil.example/.well-known/versutus-provider.json' });
  await assert.rejects(() => client.discover(), /loopback/i);
});

test('rejects an incompatible spec version', async () => {
  const stub = await startProviderStub({ incompatibleOnDiscover: true });
  after(() => stub.close());
  const client = new ManifestClient({ manifestUrl: stub.manifestUrl });
  await assert.rejects(() => client.discover(), /spec|incompatible|version/i);
});

test('rejects an oversized models body', async () => {
  const stub = await startProviderStub({ oversizedBody: true });
  after(() => stub.close());
  const adapter = await createLocalProviderAdapter({
    manifestUrl: stub.manifestUrl,
    providerId: 'echo',
    credential: 'adapter-token',
  });
  await assert.rejects(() => adapter.listModels(), /oversized|too large|body/i);
});

test('discovers health, models, and chat on a loopback adapter', async () => {
  const stub = await startProviderStub();
  after(() => stub.close());
  const adapter = await createLocalProviderAdapter({
    manifestUrl: stub.manifestUrl,
    providerId: 'echo',
    credential: 'adapter-token',
  });
  const health = await adapter.health();
  const models = await adapter.listModels();
  const chat = await adapter.chat({
    model: 'echo-1',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(health.state, 'ready');
  assert.deepEqual(models.map((model) => model.id), ['echo-1']);
  assert.equal(models[0].providerId, 'echo');
  assert.equal(chat.choices[0].message.content, 'pong');
});

test('streams chat completions as SSE deltas', async () => {
  const stub = await startProviderStub({ chatText: 'hello' });
  after(() => stub.close());
  const adapter = await createLocalProviderAdapter({
    manifestUrl: stub.manifestUrl,
    providerId: 'echo',
    credential: 'adapter-token',
  });
  const chunks = [];
  const stream = await adapter.chat({
    model: 'echo-1',
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
  });
  for await (const delta of stream) {
    chunks.push(delta);
  }
  assert.ok(chunks.join('').includes('hello'));
});

test('auth none is allowed only on loopback and is warned', async () => {
  const stub = await startProviderStub({ authSchemes: ['none'] });
  after(() => stub.close());
  const warnings = [];
  const adapter = await createLocalProviderAdapter({
    manifestUrl: stub.manifestUrl,
    providerId: 'echo',
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(adapter.credentialCustodian, 'external');
  assert.ok(warnings.some((message) => /none|unauthenticated/i.test(message)));
});

test('conformance harness passes against the example echo provider fixture', async () => {
  const stub = await startProviderStub();
  after(() => stub.close());
  const report = await runConformance(stub.origin);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checked.sort(), ['chat', 'health', 'manifest', 'models']);
});

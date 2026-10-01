import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { ProviderStore } from '../core/providers/store.mjs';

// Disabling a provider stops it answering, and says so on the card through
// `readiness.state`. The model list kept offering its models anyway, so the
// picker sent turns to a provider that could only refuse them.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

function registration(id, enabled) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id,
    label: id,
    providerType: 'openai-compatible',
    enabled,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: 'http://127.0.0.1:1/v1',
      credentialRef: `provider/${id}/api-key`,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 5000 },
  };
}

function catalog(id, modelIds) {
  return {
    source: 'live',
    state: 'fresh',
    generation: 1,
    observedAt: '2026-01-01T00:00:00.000Z',
    models: modelIds.map((modelId) => ({ id: modelId, label: modelId, providerId: id, available: true })),
  };
}

test('/v1/models omits a disabled provider and still lists the enabled ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-models-disabled-'));
  const gateHome = join(root, '.gate-home');
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  // A legacy twin with bootstrap models only, so the fallback path is here too.
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(join(root, 'registry', 'twin.json'), JSON.stringify({
    kind: 'provider',
    label: 'Twin',
    config: { flavor: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'TWIN_KEY', models: ['twin-model'] },
  }), 'utf8');

  const store = new ProviderStore(gateHome);
  await store.put(registration('live', true), {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
    catalog: catalog('live', ['live-1', 'live-2']),
  });
  await store.put(registration('off', false), {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'disabled', code: 'disabled', checkedAt: '2026-01-01T00:00:00.000Z' },
    catalog: catalog('off', ['off-1']),
  });

  const gate = await createGate({ root, gateHome, port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/models`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'list');
    assert.deepEqual(
      body.data.filter((model) => model.providerId === 'live').map((model) => model.id).sort(),
      ['live-1', 'live-2'],
    );
    assert.deepEqual(
      body.data.filter((model) => model.providerId === 'off'),
      [],
      'a disabled provider must not be offered in the picker',
    );
    // The legacy fallback is untouched: it is still listed when nothing else is.
    assert.deepEqual(
      body.data.filter((model) => model.providerId === 'twin').map((model) => model.id),
      ['twin-model'],
    );
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});
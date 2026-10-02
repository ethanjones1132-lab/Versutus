import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { ProviderStore } from '../core/providers/store.mjs';

/**
 * `GET /p/<id>/v1/models` is what a spawned CLI asks the Gate for when its base
 * url is scoped to one provider — and it resolved the provider from the legacy
 * registry only, while `POST /p/<id>/v1/chat/completions` resolves it from the
 * v2 store as well. So a provider created through the Gate's own provider UI
 * (which writes only `<gateHome>/config/providers/`, and which
 * `migrateLegacyProviders` never writes back to) served turns from a 404 model
 * list: the one source of truth that hid a working provider.
 */

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

function registration(id) {
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
      baseUrl: 'http://127.0.0.1:1/v1',
      credentialRef: `provider/${id}/api-key`,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 5000 },
  };
}

test('a provider that lives only in the v2 store serves its scoped model list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-scoped-models-'));
  const gateHome = join(root, '.gate-home');
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  // An empty `registry/` is the whole point: nothing here has a legacy twin.
  await mkdir(join(root, 'registry'), { recursive: true });

  await new ProviderStore(gateHome).put(registration('gate-made'), {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
    catalog: {
      source: 'live',
      state: 'fresh',
      generation: 1,
      observedAt: '2026-01-01T00:00:00.000Z',
      models: [{ id: 'gate-made-1', providerId: 'gate-made', available: true }],
    },
  });

  const gate = await createGate({ root, gateHome, port: 0 });
  try {
    const auth = { Authorization: `Bearer ${gate.token}` };
    const models = await fetch(`http://127.0.0.1:${gate.port}/p/gate-made/v1/models`, { headers: auth });
    assert.equal(models.status, 200, 'a provider the chat route serves must serve its model list too');
    const body = await models.json();
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data, [{ id: 'gate-made-1', provider: 'gate-made', label: 'gate-made-1', object: 'model' }]);

    // And the route the split was hiding behind: the scoped chat for this id is
    // dispatched to the same provider, so it must not be a 404 unknown_provider.
    const chat = await fetch(`http://127.0.0.1:${gate.port}/p/gate-made/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gate-made-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const chatBody = await chat.json();
    assert.notEqual(chatBody.error?.code, 'unknown_provider', `the scoped chat must be routed: ${JSON.stringify(chatBody)}`);

    // A provider that exists nowhere is still an honest 404.
    const absent = await fetch(`http://127.0.0.1:${gate.port}/p/nobody/v1/models`, { headers: auth });
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).message, 'Provider nobody not found');
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

// A fresh Gate migrates nvidia.json, whose key is an environment variable that
// nobody has set. Its bootstrap catalog still advertised two models, so the
// composer pinned the first one and the very first send was a 409 from a
// provider with no credential. Readiness is the honest answer: a provider with
// no credential is `unavailable`, and its models are not offered -- while the
// provider itself stays on the roster, naming what it needs.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

// Deliberately names no environment variable a real machine would carry.
const KEYED_ENV = 'VERSUTUS_VS160_KEYED_KEY';
const KEYLESS_ENV = 'VERSUTUS_VS160_KEYLESS_KEY';

function legacyRecord(label, envName, models) {
  return {
    kind: 'provider',
    label,
    config: {
      flavor: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKeyEnv: envName,
      models,
      streaming: true,
    },
  };
}

/**
 * A Gate owning one provider whose key is set (the environment the legacy
 * record names, which the adapter resolves) and one whose key is not, both
 * migrated from the legacy registry exactly as a fresh install's nvidia.json is.
 */
async function withTwoProviders(run) {
  const previousKeyed = process.env.VERSUTUS_VS160_KEYED_KEY;
  const previousKeyless = process.env.VERSUTUS_VS160_KEYLESS_KEY;
  process.env.VERSUTUS_VS160_KEYED_KEY = 'fixture-value';
  delete process.env.VERSUTUS_VS160_KEYLESS_KEY;

  const root = await mkdtemp(join(tmpdir(), 'gate-model-availability-'));
  const gateHome = join(root, '.gate-home');
  let gate;
  try {
    await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
    await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
    await mkdir(join(root, 'registry'), { recursive: true });
    await writeFile(
      join(root, 'registry', 'keyed.json'),
      JSON.stringify(legacyRecord('Keyed', KEYED_ENV, ['keyed-model'])),
      'utf8',
    );
    await writeFile(
      join(root, 'registry', 'keyless.json'),
      JSON.stringify(legacyRecord('Keyless', KEYLESS_ENV, ['keyless-model-a', 'keyless-model-b'])),
      'utf8',
    );
    gate = await createGate({ root, port: 0, gateHome });
    await run(gate);
  } finally {
    if (gate) await gate.close();
    await rm(root, { recursive: true, force: true });
    if (previousKeyed === undefined) delete process.env.VERSUTUS_VS160_KEYED_KEY;
    else process.env.VERSUTUS_VS160_KEYED_KEY = previousKeyed;
    if (previousKeyless === undefined) delete process.env.VERSUTUS_VS160_KEYLESS_KEY;
    else process.env.VERSUTUS_VS160_KEYLESS_KEY = previousKeyless;
  }
}

test('/v1/models offers no model from a provider with no credential', async () => {
  await withTwoProviders(async (gate) => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/models`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const byProvider = (id) => body.data.filter((model) => model.providerId === id).map((model) => model.id);

    assert.deepEqual(byProvider('keyed'), ['keyed-model'], 'a credentialed provider must still offer its models');
    assert.deepEqual(
      byProvider('keyless'),
      [],
      'a provider with no credential must not contribute a selectable model',
    );
  });
});

test('/v1/providers keeps the keyless provider visible and says it needs a key', async () => {
  await withTwoProviders(async (gate) => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/providers`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(response.status, 200);
    const { providers } = await response.json();
    const keyed = providers.find((provider) => provider.id === 'keyed');
    const keyless = providers.find((provider) => provider.id === 'keyless');

    assert.ok(keyless, 'the provider must stay on the roster so the operator can set its key');
    assert.equal(keyless.auth.state, 'missing');
    assert.equal(keyless.readiness.state, 'unavailable');
    assert.equal(keyless.readiness.code, 'missing_credentials');
    assert.ok(keyed, 'the credentialed provider must stay on the roster');
    assert.equal(keyed.auth.state, 'ready');
    assert.notEqual(keyed.readiness.code, 'missing_credentials');
  });
});

test('the manifest advertises no model behind a provider with no credential', async () => {
  await withTwoProviders(async (gate) => {
    const body = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    const keyed = body.providers.find((provider) => provider.id === 'keyed');
    const keyless = body.providers.find((provider) => provider.id === 'keyless');

    // The first-model pin on the phone reads this list, so a model here is a
    // model that can be pinned and sent to.
    assert.deepEqual(keyed.models, ['keyed-model']);
    assert.deepEqual(keyless.models, [], 'a keyless provider must not supply the manifest model list');
    assert.equal(keyless.auth.state, 'missing');
  });
});

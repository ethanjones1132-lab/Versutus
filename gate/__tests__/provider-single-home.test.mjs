import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-home-'));
  roots.push(root);
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  return createGate({ root, port: 0, gateHome: join(root, '.gate-home') });
}

async function rpc(gate, method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ method, params }),
  });
  return response.json();
}

const providerConfig = {
  flavor: 'openai',
  apiKeyEnv: 'SOME_KEY',
  models: ['m1'],
  baseUrl: 'https://example.com/v1',
};

/**
 * Two registration paths for the same object produced two half-configured
 * providers and a key written where no adapter reads it. Providers get exactly
 * one home: the providers.* methods.
 */
test('registry.instances.create refuses providers and names the right method', async () => {
  const gate = await makeGate();
  try {
    const body = await rpc(gate, 'registry.instances.create', {
      id: 'acme', kind: 'provider', label: 'Acme', config: providerConfig,
    });
    assert.ok(body.error, 'provider creation through the capability registry should be refused');
    assert.match(body.error.message, /providers\.create/);
  } finally {
    await gate.close();
  }
});

test('registry.instances.update refuses providers too', async () => {
  const gate = await makeGate();
  try {
    const body = await rpc(gate, 'registry.instances.update', {
      id: 'acme', label: 'Acme', config: providerConfig,
    });
    assert.ok(body.error);
    assert.match(body.error.message, /providers\.update|not found/i);
  } finally {
    await gate.close();
  }
});

test('registry.secrets.set refuses provider credential refs', async () => {
  const gate = await makeGate();
  try {
    // This ref is what a provider adapter reads, but setSecret writes to the
    // Gate-root store — a key saved here would never be found.
    const body = await rpc(gate, 'registry.secrets.set', {
      refName: 'provider/acme/api-key', value: 'sk-test',
    });
    assert.ok(body.error);
    assert.match(body.error.message, /providers\.auth\.setApiKey/);
  } finally {
    await gate.close();
  }
});

test('registry.secrets.set refuses a credential pasted into the ref field', async () => {
  const gate = await makeGate();
  try {
    // The vault names each file after its ref, so this would have written the
    // key itself into a filename on disk — observed on 2026-08-14.
    const body = await rpc(gate, 'registry.secrets.set', {
      refName: 'sk-Q0f4ioEsl3tE7Hm4ahCvlLIfuPoKxp6OAgXxaoy3mbDP22JR',
      value: 'the-actual-secret',
    });
    assert.ok(body.error, 'a credential-shaped refName must be refused');
    assert.match(body.error.message, /names the secret/i);
  } finally {
    await gate.close();
  }
});

test('registry.secrets.set still accepts an ordinary ref name', async () => {
  const gate = await makeGate();
  try {
    const body = await rpc(gate, 'registry.secrets.set', {
      refName: 'my-memory-token',
      value: 'sk-this-is-fine-here',
    });
    assert.equal(body.error, undefined, body.error?.message);
    assert.equal(body.result?.ok, true);
  } finally {
    await gate.close();
  }
});

test('non-provider capability kinds are unaffected', async () => {
  const gate = await makeGate();
  try {
    const body = await rpc(gate, 'registry.secrets.set', { refName: 'SOME_KEY', value: 'v' });
    assert.equal(body.error, undefined, 'legacy instance secrets still work');
    assert.equal(body.result.ok, true);
  } finally {
    await gate.close();
  }
});

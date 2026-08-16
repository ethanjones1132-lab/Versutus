import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gateWithProvider() {
  const root = await mkdtemp(join(tmpdir(), 'gate-manifest-'));
  const gateHome = join(root, 'home');
  roots.push(root);
  // A v2 provider record, as ProviderService persists it under Gate home.
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(
    join(gateHome, 'config', 'providers', 'nvidia.json'),
    JSON.stringify({
      schemaVersion: 2,
      kind: 'provider',
      id: 'nvidia',
      label: 'NVIDIA NIM',
      providerType: 'nvidia-nim',
      enabled: true,
      registration: { mode: 'api_key', protocol: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', credentialRef: 'provider/nvidia/api-key' },
    }),
    'utf8',
  );
  const gate = await createGate({ root, port: 0, gateHome });
  return gate;
}

test('a provider owned by ProviderService appears in the manifest', async () => {
  const gate = await gateWithProvider();
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    const entry = manifest.providers.find((provider) => provider.id === 'nvidia');
    assert.ok(entry, 'the configured provider must be advertised');
    assert.equal(entry.label, 'NVIDIA NIM');
    assert.ok(entry.readiness?.state, 'readiness must be carried');
    assert.ok(entry.catalog?.state, 'catalog state must be carried');
  } finally {
    await gate.close();
  }
});

test('the manifest still builds when the provider service fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-manifest-fail-'));
  roots.push(root);
  const gate = await createGate({ root, port: 0, gateHome: join(root, 'home') });
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.ok(Array.isArray(manifest.providers), 'providers must always be an array');
    assert.equal(manifest.capabilities.providers, true);
  } finally {
    await gate.close();
  }
});

test('registering a provider via RPC reaches the manifest without a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-manifest-rpc-'));
  roots.push(root);
  const gate = await createGate({ root, port: 0, gateHome: join(root, 'home') });
  try {
    const before = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.equal(before.providers.find((provider) => provider.id === 'acme'), undefined);

    const rpcResponse = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        method: 'providers.create',
        params: {
          schemaVersion: 2,
          kind: 'provider',
          id: 'acme',
          label: 'Acme',
          providerType: 'openai',
          enabled: true,
          registration: {
            mode: 'api_key',
            protocol: 'openai_chat',
            baseUrl: 'https://api.openai.com/v1',
            credentialRef: 'provider/acme/api-key',
          },
          catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
          requestPolicy: { timeoutMs: 120000 },
        },
      }),
    });
    assert.equal(rpcResponse.status, 200);

    const after = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.ok(
      after.providers.find((provider) => provider.id === 'acme'),
      'a provider registered over RPC must be visible in the manifest without restarting the Gate',
    );
  } finally {
    await gate.close();
  }
});

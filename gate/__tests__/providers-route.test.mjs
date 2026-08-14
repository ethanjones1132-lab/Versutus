import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

async function gateWithProviders(records) {
  const root = await mkdtemp(join(tmpdir(), 'gate-providers-route-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  for (const record of records) {
    await writeFile(join(root, 'registry', `${record.id}.json`), JSON.stringify({
      kind: 'provider',
      label: record.label,
      config: record.config,
    }), 'utf8');
  }
  const gate = await createGate({ root, port: 0, gateHome: join(root, '.gate-home') });
  return gate;
}

test('GET /v1/providers returns sanitized snapshots without secrets', async () => {
  const gate = await gateWithProviders([{
    id: 'alpha',
    label: 'Alpha',
    config: {
      flavor: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'ALPHA_KEY',
      models: ['shared-model'],
      streaming: true,
    },
  }]);
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/providers`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.providers[0].id, 'alpha');
    assert.equal(body.providers[0].catalog.source, 'legacy_bootstrap');
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('ALPHA_KEY'), false);
    assert.equal(serialized.includes('secret'), false);
  } finally {
    await gate.close();
  }
});

test('providers.auth.setApiKey is status-only and does not echo the secret', async () => {
  const gate = await gateWithProviders([{
    id: 'alpha',
    label: 'Alpha',
    config: {
      flavor: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'ALPHA_KEY',
      models: ['shared-model'],
      streaming: true,
    },
  }]);
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gate.token}`,
      },
      body: JSON.stringify({
        method: 'providers.auth.setApiKey',
        params: { id: 'alpha', value: 'sk-live-should-not-echo' },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.ok, true);
    assert.equal(JSON.stringify(body).includes('sk-live-should-not-echo'), false);
  } finally {
    await gate.close();
  }
});

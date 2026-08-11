import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

async function testProviderDir() {
  const root = await mkdtemp(join(tmpdir(), 'gate-server-test-'));
  await mkdir(join(root, 'test-provider'), { recursive: true });
  await writeFile(
    join(root, 'test-provider', 'provider.mjs'),
    `
export const id = 'test-provider';
export const label = 'Test Provider';
export const config = {
  flavor: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'TEST_KEY',
  models: ['test-model-1', 'test-model-2'],
  capabilities: { chat: true, streaming: true },
};
`,
    'utf8'
  );
  return root;
}

test('health endpoint is unauthenticated', async () => {
  const providersDir = await testProviderDir();
  const gate = await createGate({ providersDir, port: 0 });

  try {
    const response = await fetch(`http://localhost:${gate.port}/health`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status, 'ok');
  } finally {
    await gate.close();
  }
});

test('manifest endpoint is unauthenticated', async () => {
  const providersDir = await testProviderDir();
  const gate = await createGate({ providersDir, port: 0 });

  try {
    const response = await fetch(
      `http://localhost:${gate.port}/.well-known/gateway.json`
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.manifest);
    assert.ok(data.kind);
    assert.ok(Array.isArray(data.providers));
  } finally {
    await gate.close();
  }
});

test('models endpoint requires authentication', async () => {
  const providersDir = await testProviderDir();
  const gate = await createGate({ providersDir, port: 0 });

  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/models`);
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});

test('authenticated models endpoint returns all provider models', async () => {
  const providersDir = await testProviderDir();
  const gate = await createGate({ providersDir, port: 0 });

  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/models`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(Array.isArray(data.data));
    const modelIds = data.data.map((m) => m.id);
    assert.ok(modelIds.includes('test-model-1'));
    assert.ok(modelIds.includes('test-model-2'));
  } finally {
    await gate.close();
  }
});

test('scoped models endpoint returns provider-specific models', async () => {
  const providersDir = await testProviderDir();
  const gate = await createGate({ providersDir, port: 0 });

  try {
    const response = await fetch(
      `http://localhost:${gate.port}/p/test-provider/v1/models`,
      {
        headers: { Authorization: `Bearer ${gate.token}` },
      }
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(Array.isArray(data.data));
    const modelIds = data.data.map((m) => m.id);
    assert.ok(modelIds.includes('test-model-1'));
    assert.ok(modelIds.includes('test-model-2'));
  } finally {
    await gate.close();
  }
});

test('unknown route returns 404', async () => {
  const providersDir = await testProviderDir();
  const gate = await createGate({ providersDir, port: 0 });

  try {
    const response = await fetch(`http://localhost:${gate.port}/unknown`);
    assert.equal(response.status, 404);
  } finally {
    await gate.close();
  }
});

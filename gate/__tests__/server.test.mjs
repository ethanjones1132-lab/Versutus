import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

async function testSetup() {
  const root = await mkdtemp(join(tmpdir(), 'gate-server-test-'));
  await mkdir(join(root, 'providers', 'test-provider'), { recursive: true });
  await writeFile(
    join(root, 'providers', 'test-provider', 'provider.mjs'),
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
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });

  try {
    const response = await fetch(`http://localhost:${gate.port}/health`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status, 'ok');
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest endpoint is unauthenticated', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });

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
    await rm(root, { recursive: true, force: true });
  }
});

test('models endpoint requires authentication', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });

  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/models`);
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('authenticated models endpoint returns all provider models', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });

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
    await rm(root, { recursive: true, force: true });
  }
});

test('scoped models endpoint returns provider-specific models', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });

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
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown route returns 404', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });

  try {
    const response = await fetch(`http://localhost:${gate.port}/unknown`);
    assert.equal(response.status, 404);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('token store persists under the gate root', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  const tokenPath = join(root, '.tokens.json');

  try {
    // Verify token file exists in the gate root directory
    const tokenContent = await readFile(tokenPath, 'utf-8');
    const tokenData = JSON.parse(tokenContent);
    assert.ok(tokenData.token, 'Token file should contain a token');
    assert.equal(gate.token, tokenData.token, 'Gate token should match stored token');
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

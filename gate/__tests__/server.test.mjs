import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

async function testSetup() {
  const root = await mkdtemp(join(tmpdir(), 'gate-server-test-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(
    kindModulePath,
    join(root, 'core', 'capabilities', 'provider', 'kind.mjs'),
  );
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(
    join(root, 'registry', 'test-provider.json'),
    JSON.stringify({
      kind: 'provider',
      label: 'Test Provider',
      config: {
        flavor: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'TEST_KEY',
        models: ['test-model-1', 'test-model-2'],
        streaming: true,
      },
    }),
    'utf8',
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

test('scoped provider health mirrors root health for child base URLs', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });

  try {
    const response = await fetch(`http://localhost:${gate.port}/p/test-provider/health`);
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

function signedAccessBody(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64Url = der.subarray(der.length - 32).toString('base64url');
  const deviceId = overrides.deviceId ?? 'device-test';
  const clientId = 'versutus-mobile';
  const role = 'operator';
  const scopes = ['chat:send'];
  const signedAtMs = Date.now();
  const payload = ['v4', deviceId, clientId, role, scopes.join(','), String(signedAtMs)].join('|');
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');

  return {
    manifest: 'versutus-gateway/v1',
    device: { id: deviceId, publicKey: publicKeyB64Url, clientId, clientMode: 'ui' },
    role,
    scopes,
    signedAtMs,
    signature,
  };
}

test('a fresh device gets pending-approval when the pairing window is closed', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/.well-known/gateway/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedAccessBody()),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'pending');
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a bad signature is denied, not queued', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  try {
    const body = signedAccessBody();
    body.signature = 'aW52YWxpZA'; // valid base64url, wrong signature
    const response = await fetch(`http://localhost:${gate.port}/.well-known/gateway/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).status, 'denied');
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a device token issued via pairing authenticates like the bootstrap token', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  try {
    // Approve directly through the same store the server reads, standing in
    // for `cli.mjs pair approve` running as a separate process.
    const { PairingStore } = await import('../core/pairing.mjs');
    const { DeviceTokenStore } = await import('../core/device-tokens.mjs');
    const pairing = new PairingStore(join(root, '.pairing.json'));
    const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));

    const accessBody = signedAccessBody();
    await fetch(`http://localhost:${gate.port}/.well-known/gateway/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accessBody),
    });
    const [pending] = await pairing.listPending();
    const token = await deviceTokens.issue(pending.deviceId, { role: pending.role, scopes: pending.scopes });
    await pairing.takePending(pending.requestId);

    const response = await fetch(`http://localhost:${gate.port}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

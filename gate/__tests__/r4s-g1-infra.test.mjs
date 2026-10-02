import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import fsPromises, { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { createGate } from '../core/server.mjs';
import { PairingStore } from '../core/pairing.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

async function testSetup() {
  const root = await mkdtemp(join(tmpdir(), 'gate-r4s-g1-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  return root;
}

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

function rawGet(port, { host, path = '/v1/models' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error(`response never completed: ${JSON.stringify(data)}`)), 1500);
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\r\n\r\n')) finish();
    });
    socket.on('end', () => { if (data) finish(); });
    socket.on('error', (error) => finish(error));
  });
}

test('a malformed Host is answered 400 instead of leaving the socket open', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const first = await rawGet(gate.port, { host: 'a b' });
    assert.match(first, /^HTTP\/1\.1 400 /);
    assert.match(first, /invalid_host/);

    for (let i = 0; i < 21; i += 1) {
      const response = await rawGet(gate.port, { host: 'foo:bar:baz' });
      assert.match(response, /^HTTP\/1\.1 400 /);
    }
    assert.equal(rejections.length, 0, 'malformed Host must not become an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onRejection);
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a re-sent signed access request is answered with the token already issued', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  try {
    const pairing = new PairingStore(join(root, '.pairing.json'));
    await pairing.openWindow(60_000);
    const body = JSON.stringify(signedAccessBody());
    const headers = { 'Content-Type': 'application/json' };
    const url = `http://127.0.0.1:${gate.port}/.well-known/gateway/access`;
    const first = await fetch(url, { method: 'POST', headers, body });
    const second = await fetch(url, { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const granted = await first.json();
    const replayed = await second.json();
    assert.equal(granted.status, 'granted');
    assert.equal(replayed.status, 'granted');
    assert.equal(replayed.token, granted.token);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a re-sent pending access request returns the same requestId, not 403 replay', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  try {
    const body = JSON.stringify(signedAccessBody({ deviceId: 'device-pending' }));
    const headers = { 'Content-Type': 'application/json' };
    const url = `http://127.0.0.1:${gate.port}/.well-known/gateway/access`;
    const first = await fetch(url, { method: 'POST', headers, body });
    const second = await fetch(url, { method: 'POST', headers, body });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const pending = await first.json();
    const replayed = await second.json();
    assert.equal(pending.status, 'pending');
    assert.equal(replayed.status, 'pending');
    assert.equal(replayed.requestId, pending.requestId);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('authenticated routes with no handler answer 404 instead of hanging', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  try {
    const auth = { Authorization: `Bearer ${gate.token}` };
    const base = `http://127.0.0.1:${gate.port}`;
    const deadline = (promise) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('response never completed')), 2000)),
    ]);
    const steer = await deadline(fetch(`${base}/v1/runs/anything/steer`, { method: 'POST', headers: auth }));
    assert.equal(steer.status, 404);
    const sessionGet = await deadline(fetch(`${base}/v1/sessions/ses_x`, { headers: auth }));
    assert.equal(sessionGet.status, 404);
    const runDelete = await deadline(fetch(`${base}/v1/runs/run_x`, { method: 'DELETE', headers: auth }));
    assert.equal(runDelete.status, 404);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a locked device store answers 503 rather than 401ing every phone', async () => {
  const root = await testSetup();
  const gate = await createGate({ root, port: 0 });
  const path = join(root, '.device-tokens.json');
  const original = fsPromises.readFile;
  fsPromises.readFile = async (target, ...rest) => {
    if (String(target) === path) {
      const error = new Error('EBUSY: resource busy or locked');
      error.code = 'EBUSY';
      throw error;
    }
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/models`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(response.status, 503);
  } finally {
    fsPromises.readFile = original;
    syncBuiltinESMExports();
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

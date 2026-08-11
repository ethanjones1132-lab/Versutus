import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PairingStore } from '../core/pairing.mjs';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-pairing-'));
  return new PairingStore(join(dir, 'pairing.json'));
}

test('window is closed by default', async () => {
  const pairing = await store();
  assert.equal(await pairing.isWindowOpen(), false);
});

test('opening a window makes it open until it expires', async () => {
  const pairing = await store();
  await pairing.openWindow(1000);
  assert.equal(await pairing.isWindowOpen(), true);
});

test('adds a pending request and lists it', async () => {
  const pairing = await store();
  const requestId = await pairing.addPending({
    deviceId: 'device-1',
    publicKeyB64Url: 'key',
    clientId: 'versutus-mobile',
    role: 'operator',
    scopes: ['chat:send'],
  });

  const pending = await pairing.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, requestId);
  assert.equal(pending[0].deviceId, 'device-1');
});

test('a second request from the same device replaces the first', async () => {
  const pairing = await store();
  await pairing.addPending({ deviceId: 'device-1', publicKeyB64Url: 'key', clientId: 'c', role: 'operator', scopes: [] });
  await pairing.addPending({ deviceId: 'device-1', publicKeyB64Url: 'key2', clientId: 'c', role: 'operator', scopes: [] });

  const pending = await pairing.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].publicKeyB64Url, 'key2');
});

test('takePending removes and returns the request', async () => {
  const pairing = await store();
  const requestId = await pairing.addPending({ deviceId: 'device-1', publicKeyB64Url: 'key', clientId: 'c', role: 'operator', scopes: [] });

  const taken = await pairing.takePending(requestId);
  assert.equal(taken.deviceId, 'device-1');
  assert.deepEqual(await pairing.listPending(), []);
});

test('takePending returns null for an unknown id', async () => {
  const pairing = await store();
  assert.equal(await pairing.takePending('nope'), null);
});

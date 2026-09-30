import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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

test('the pending list is capped at 50 entries, oldest dropped', async () => {
  const pairing = await store();
  for (let index = 0; index < 60; index += 1) {
    await pairing.addPending({
      deviceId: `device-${index}`,
      publicKeyB64Url: 'key',
      clientId: 'c',
      role: 'operator',
      scopes: [],
    });
  }

  const pending = await pairing.listPending();
  assert.equal(pending.length, 50);
  assert.equal(pending[0].deviceId, 'device-10', 'the ten oldest requests are dropped');
  assert.equal(pending[49].deviceId, 'device-59');
});

test('concurrent addPending calls keep every request (up to the cap)', async () => {
  const pairing = await store();
  await Promise.all(
    Array.from({ length: 30 }, (_, index) => pairing.addPending({
      deviceId: `device-${index}`,
      publicKeyB64Url: 'key',
      clientId: 'c',
      role: 'operator',
      scopes: [],
    })),
  );

  const pending = await pairing.listPending();
  assert.equal(pending.length, 30);
  const ids = new Set(pending.map((entry) => entry.deviceId));
  assert.equal(ids.size, 30, 'no request lost a race');
});

test('read-only calls on a corrupt file create no backups and log nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-pairing-'));
  const path = join(dir, 'pairing.json');
  await writeFile(path, '{ not json', 'utf8');
  const pairing = new PairingStore(path);

  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    for (let index = 0; index < 20; index += 1) {
      assert.equal(await pairing.isWindowOpen(), false, 'a corrupt file reads as a closed window');
    }
    assert.deepEqual(await pairing.listPending(), [], 'a corrupt file reads as no pending requests');
  } finally {
    console.error = originalError;
  }

  const files = await readdir(dir);
  assert.equal(
    files.filter((name) => name.startsWith('pairing.json.corrupt-')).length,
    0,
    'read-only paths must not quarantine',
  );
  assert.deepEqual(errors, [], 'read-only paths must not log');
});

test('a mutation on a corrupt file quarantines it once, loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-pairing-'));
  const path = join(dir, 'pairing.json');
  await writeFile(path, '{ not json', 'utf8');
  const pairing = new PairingStore(path);

  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await pairing.addPending({ deviceId: 'device-1', publicKeyB64Url: 'key', clientId: 'c', role: 'operator', scopes: [] });
  } finally {
    console.error = originalError;
  }

  let files = await readdir(dir);
  const backup = files.find((name) => name.startsWith('pairing.json.corrupt-'));
  assert.ok(backup, 'the corrupt file must be copied aside');
  assert.equal(await readFile(join(dir, backup), 'utf8'), '{ not json');
  assert.ok(errors.some((line) => line.includes('unreadable')), 'the failure must be logged loudly');

  // The mutation's write replaced the file, so the corrupt state cleared: a
  // later read-only call writes no second backup and logs no second line.
  const errors2 = [];
  console.error = (...args) => errors2.push(args.join(' '));
  try {
    assert.equal(await pairing.isWindowOpen(), false);
  } finally {
    console.error = originalError;
  }
  files = await readdir(dir);
  assert.equal(
    files.filter((name) => name.startsWith('pairing.json.corrupt-')).length,
    1,
    'the quarantine happened once per corrupt state',
  );
  assert.deepEqual(errors2, []);
});

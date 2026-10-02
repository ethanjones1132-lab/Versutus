import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceTokenStore } from '../core/device-tokens.mjs';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-device-tokens-'));
  return new DeviceTokenStore(join(dir, 'devices.json'));
}

test('issues a token and verifies it back to the device identity', async () => {
  const tokens = await store();
  const token = await tokens.issue('device-1', { role: 'operator', scopes: ['chat:send'] });
  const verified = await tokens.verify(`Bearer ${token}`);

  assert.equal(verified?.deviceId, 'device-1');
  assert.equal(verified?.role, 'operator');
  assert.deepEqual(verified?.scopes, ['chat:send']);
});

test('rejects an unknown token', async () => {
  const tokens = await store();
  await tokens.issue('device-1', { role: 'operator', scopes: [] });
  assert.equal(await tokens.verify('Bearer not-issued'), null);
});

test('revoke stops the token from verifying', async () => {
  const tokens = await store();
  const token = await tokens.issue('device-1', { role: 'operator', scopes: [] });
  const found = await tokens.revoke('device-1');

  assert.equal(found, true);
  assert.equal(await tokens.verify(`Bearer ${token}`), null);
});

test('revoking an unknown device reports not found', async () => {
  const tokens = await store();
  assert.equal(await tokens.revoke('nope'), false);
});

test('reissuing a device replaces its previous token', async () => {
  const tokens = await store();
  const first = await tokens.issue('device-1', { role: 'operator', scopes: [] });
  const second = await tokens.issue('device-1', { role: 'operator', scopes: [] });

  assert.notEqual(first, second);
  assert.equal(await tokens.verify(`Bearer ${first}`), null);
  assert.ok(await tokens.verify(`Bearer ${second}`));
});

test('list reports every device including revoked ones', async () => {
  const tokens = await store();
  await tokens.issue('device-1', { role: 'operator', scopes: [] });
  await tokens.issue('device-2', { role: 'operator', scopes: [] });
  await tokens.revoke('device-2');

  const all = await tokens.list();
  assert.equal(all.length, 2);
  assert.equal(all.find((d) => d.deviceId === 'device-2')?.revoked, true);
});

test('a corrupt file is backed up, not silently emptied by issue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-device-tokens-'));
  const path = join(dir, 'devices.json');
  await writeFile(path, '{ not json', 'utf8');
  const tokens = new DeviceTokenStore(path);

  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await tokens.issue('device-1', { role: 'operator', scopes: [] });
  } finally {
    console.error = originalError;
  }

  const files = await readdir(dir);
  const backup = files.find((name) => name.startsWith('devices.json.corrupt-'));
  assert.ok(backup, 'the corrupt file must be copied aside');
  assert.equal(await readFile(join(dir, backup), 'utf8'), '{ not json');
  assert.ok(errors.some((line) => line.includes('unreadable')), 'the failure must be logged loudly');

  // The store proceeded from an empty list: the new device is the only one.
  const all = await tokens.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].deviceId, 'device-1');
});

test('issue for device B keeps device A', async () => {
  const tokens = await store();
  await tokens.issue('device-A', { role: 'operator', scopes: [] });
  await tokens.issue('device-B', { role: 'operator', scopes: [] });

  const all = await tokens.list();
  assert.equal(all.length, 2);
  assert.ok(all.some((d) => d.deviceId === 'device-A'));
  assert.ok(all.some((d) => d.deviceId === 'device-B'));
});

test('concurrent issue calls keep both devices', async () => {
  const tokens = await store();
  await Promise.all([
    tokens.issue('device-A', { role: 'operator', scopes: [] }),
    tokens.issue('device-B', { role: 'operator', scopes: [] }),
    tokens.issue('device-C', { role: 'operator', scopes: [] }),
  ]);

  const all = await tokens.list();
  assert.equal(all.length, 3);
  const ids = all.map((d) => d.deviceId).sort();
  assert.deepEqual(ids, ['device-A', 'device-B', 'device-C']);
});

test('revoke works across instances (separate process simulation)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-device-tokens-'));
  const path = join(dir, 'devices.json');
  const first = new DeviceTokenStore(path);
  const token = await first.issue('device-1', { role: 'operator', scopes: [] });

  // A second instance over the same file stands in for `cli.mjs pair revoke`.
  const second = new DeviceTokenStore(path);
  assert.equal(await second.revoke('device-1'), true);

  assert.equal(await first.verify(`Bearer ${token}`), null);
  assert.equal(await second.verify(`Bearer ${token}`), null);
});

test('a brief lock on the device store does not 401 a paired token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-device-tokens-'));
  const path = join(dir, 'devices.json');
  const tokens = new DeviceTokenStore(path);
  const token = await tokens.issue('device-1', { role: 'operator', scopes: [] });

  const original = fsPromises.readFile;
  let refusals = 0;
  fsPromises.readFile = async (target, ...rest) => {
    if (String(target) === path && refusals < 2) {
      refusals += 1;
      const error = new Error('EBUSY: resource busy or locked');
      error.code = 'EBUSY';
      throw error;
    }
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const verified = await tokens.verify(`Bearer ${token}`);
    assert.equal(verified?.deviceId, 'device-1');
    assert.equal(refusals, 2);
  } finally {
    fsPromises.readFile = original;
    syncBuiltinESMExports();
  }
});

test('a lock that never clears is not reported as an empty device list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-device-tokens-'));
  const path = join(dir, 'devices.json');
  const tokens = new DeviceTokenStore(path);
  await tokens.issue('device-1', { role: 'operator', scopes: [] });

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
    await assert.rejects(() => tokens.verify('Bearer x'), (error) => error?.code === 'EBUSY');
  } finally {
    fsPromises.readFile = original;
    syncBuiltinESMExports();
  }
});

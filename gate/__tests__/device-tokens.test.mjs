import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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

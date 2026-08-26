import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGatewayMethods } from '../core/capabilities/gateway-methods.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';
import { createGate } from '../core/server.mjs';

test('device.list returns public fields and never a token', async () => {
  const methods = createGatewayMethods({
    getBackend: async () => ({}),
    listDevices: async () => [
      {
        deviceId: 'phone-1',
        token: 'must-not-leave-the-store',
        role: 'operator',
        scopes: ['operator.read'],
        issuedAtMs: 1_700_000_000_000,
        revoked: false,
      },
    ],
  });

  const result = await methods['device.list']({});
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].deviceId, 'phone-1');
  assert.equal(result.devices[0].role, 'operator');
  assert.deepEqual(result.devices[0].scopes, ['operator.read']);
  assert.equal(result.devices[0].issuedAtMs, 1_700_000_000_000);
  assert.equal(result.devices[0].revoked, false);
  assert.equal('token' in result.devices[0], false);
  assert.equal(JSON.stringify(result).includes('must-not-leave-the-store'), false);
});

test('device.list on a live Gate never puts a token on the wire', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-device-list-'));
  const store = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const secret = await store.issue('phone-1', { role: 'operator', scopes: ['operator.read'] });
  await store.issue('tablet-1', { role: 'operator', scopes: ['chat:send'] });
  await store.revoke('tablet-1');

  const gate = await createGate({ root, port: 0 });
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.ok(manifest.rpcMethods.includes('device.list'), 'device.list must be advertised');

    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'device.list', params: {} }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const wire = JSON.stringify(body);
    assert.equal(wire.includes(secret), false, 'issued token must not appear on the wire');
    assert.equal(/"token"\s*:/.test(wire), false, 'no token field on the wire');

    const devices = body.result?.devices;
    assert.ok(Array.isArray(devices));
    assert.equal(devices.length, 2);
    const phone = devices.find((entry) => entry.deviceId === 'phone-1');
    const tablet = devices.find((entry) => entry.deviceId === 'tablet-1');
    assert.equal(phone?.role, 'operator');
    assert.deepEqual(phone?.scopes, ['operator.read']);
    assert.equal(phone?.revoked, false);
    assert.equal('token' in phone, false);
    assert.equal(tablet?.revoked, true);
  } finally {
    await gate.close();
  }
});

test('device.list is empty-ok when this Gate has paired none', async () => {
  const methods = createGatewayMethods({
    getBackend: async () => ({}),
    listDevices: async () => [],
  });
  const result = await methods['device.list']({});
  assert.deepEqual(result, { devices: [] });
});

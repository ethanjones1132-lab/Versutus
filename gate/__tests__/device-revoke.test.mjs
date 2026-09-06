import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGatewayMethods } from '../core/capabilities/gateway-methods.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';
import { createGate } from '../core/server.mjs';

test('device.revoke revokes through the store and answers public fields only', async () => {
  const revoked = [];
  const methods = createGatewayMethods({
    getBackend: async () => ({}),
    listDevices: async () => [],
    revokeDevice: async (deviceId) => {
      revoked.push(deviceId);
      return true;
    },
  });

  const result = await methods['device.revoke']({ deviceId: 'phone-1' });
  assert.deepEqual(result, { deviceId: 'phone-1', revoked: true });
  assert.deepEqual(revoked, ['phone-1']);
  assert.equal(JSON.stringify(result).includes('token'), false);
});

test('device.revoke requires a device id', async () => {
  const methods = createGatewayMethods({
    getBackend: async () => ({}),
    listDevices: async () => [],
    revokeDevice: async () => true,
  });

  await assert.rejects(methods['device.revoke']({}), /deviceId is required/);
  await assert.rejects(methods['device.revoke']({ deviceId: '  ' }), /deviceId is required/);
});

test('device.revoke reports an unknown device instead of a silent no-op', async () => {
  const methods = createGatewayMethods({
    getBackend: async () => ({}),
    listDevices: async () => [],
    revokeDevice: async () => false,
  });

  await assert.rejects(methods['device.revoke']({ deviceId: 'ghost' }), /No device "ghost" on file/);
});

test('device.revoke without a device registry fails honestly', async () => {
  const methods = createGatewayMethods({ getBackend: async () => ({}) });

  await assert.rejects(
    methods['device.revoke']({ deviceId: 'phone-1' }),
    /does not keep a device registry/,
  );
});

test('device.revoke on a live Gate is advertised, revokes, and never puts a token on the wire', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-device-revoke-'));
  const store = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const secret = await store.issue('phone-1', { role: 'operator', scopes: ['operator.read'] });

  const gate = await createGate({ root, port: 0 });
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.ok(manifest.rpcMethods.includes('device.revoke'), 'device.revoke must be advertised');

    const revoke = async (params) =>
      fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
        body: JSON.stringify({ method: 'device.revoke', params }),
      });

    const response = await revoke({ deviceId: 'phone-1' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result, { deviceId: 'phone-1', revoked: true });
    assert.equal(JSON.stringify(body).includes(secret), false, 'issued token must not appear on the wire');
    assert.equal(/"token"\s*:/.test(JSON.stringify(body)), false, 'no token field on the wire');

    const list = await (
      await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
        body: JSON.stringify({ method: 'device.list', params: {} }),
      })
    ).json();
    const phone = list.result?.devices?.find((entry) => entry.deviceId === 'phone-1');
    assert.equal(phone?.revoked, true, 'the stored token must read back revoked');

    const unknown = await revoke({ deviceId: 'ghost' });
    assert.equal(unknown.status, 400);
    const unknownBody = await unknown.json();
    assert.match(unknownBody.error?.message ?? '', /No device "ghost" on file/);

    const missing = await revoke({});
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.match(missingBody.error?.message ?? '', /deviceId is required/);
  } finally {
    await gate.close();
  }
});

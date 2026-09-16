import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceTokenStore } from '../core/device-tokens.mjs';
import { createGate } from '../core/server.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gate-push-rpc-'));
  const gateHome = join(root, 'home');
  const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const pairedToken = await deviceTokens.issue('phone-grant', { role: 'operator', scopes: ['operator.read'] });
  const pushFetchCalls = [];
  const pushFetch = async (url, init) => {
    pushFetchCalls.push({ url, init });
    if (url.endsWith('/push/send')) {
      const messages = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: messages.map((message, index) => ({ status: 'ok', id: `ticket-${index}` })) };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        const ids = JSON.parse(init.body).ids;
        return { data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) };
      },
    };
  };
  const gate = await createGate({ root, port: 0, gateHome, pushFetch });
  return { root, gateHome, pairedToken, pushFetchCalls, gate };
}

async function rpc(gate, auth, method, params = {}) {
  return fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({ method, params }),
  });
}

test('rejects an unauthenticated notification RPC', async () => {
  const { gate } = await fixture();
  try {
    const response = await rpc(gate, null, 'notifications.preferences.get');
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});

test('rejects a bootstrap token with pairing_required', async () => {
  const { gate } = await fixture();
  try {
    const response = await rpc(gate, gate.token, 'notifications.register', {
      expoPushToken: 'ExponentPushToken[phone]',
      platform: 'ios',
      timezone: 'UTC',
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, 'pairing_required');
  } finally {
    await gate.close();
  }
});

test('a bootstrap-token phone registers under its own device id, kept apart from paired grants', async () => {
  // 2026-09-16: the phone connects with the Gate's bootstrap token, so every
  // registration was refused 403 pairing_required and swallowed by the app —
  // push could never reach it, however many times notifications were allowed.
  // The bootstrap token is already full operator access; what must still hold
  // is that it cannot overwrite a PAIRED device's row, so it registers under a
  // separate `bootstrap:` namespace.
  const { gateHome, gate } = await fixture();
  try {
    const response = await rpc(gate, gate.token, 'notifications.register', {
      expoPushToken: 'ExponentPushToken[bootstrap-phone]',
      platform: 'android',
      timezone: 'America/New_York',
      deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    });
    assert.equal(response.status, 200);
    const rows = JSON.parse(await readFile(join(gateHome, 'push-tokens.json'), 'utf8'));
    const stored = rows.devices ?? rows;
    assert.ok(stored['bootstrap:a1b2c3d4e5f60718293a4b5c6d7e8f90']);
    assert.equal(stored['bootstrap:a1b2c3d4e5f60718293a4b5c6d7e8f90'].expoPushToken, 'ExponentPushToken[bootstrap-phone]');
  } finally {
    await gate.close();
  }
});

test("a bootstrap registration naming a paired device's id cannot overwrite that device", async () => {
  const { gateHome, pairedToken, gate } = await fixture();
  try {
    const paired = await rpc(gate, pairedToken, 'notifications.register', {
      expoPushToken: 'ExponentPushToken[real-paired-phone]', platform: 'ios', timezone: 'UTC',
    });
    assert.equal(paired.status, 200);
    const spoof = await rpc(gate, gate.token, 'notifications.register', {
      expoPushToken: 'ExponentPushToken[spoof]', platform: 'android', timezone: 'UTC', deviceId: 'phone-grant',
    });
    assert.equal(spoof.status, 200);
    const rows = JSON.parse(await readFile(join(gateHome, 'push-tokens.json'), 'utf8'));
    const stored = rows.devices ?? rows;
    assert.equal(stored['phone-grant'].expoPushToken, 'ExponentPushToken[real-paired-phone]');
    assert.equal(stored['bootstrap:phone-grant'].expoPushToken, 'ExponentPushToken[spoof]');
  } finally {
    await gate.close();
  }
});

test('a bootstrap registration with a malformed device id is still refused', async () => {
  const { gate } = await fixture();
  try {
    for (const deviceId of ['', 'x', 'has space in it', 'a'.repeat(300), 42]) {
      const response = await rpc(gate, gate.token, 'notifications.register', {
        expoPushToken: 'ExponentPushToken[phone]', platform: 'android', timezone: 'UTC', deviceId,
      });
      assert.equal(response.status, 403, `deviceId ${JSON.stringify(deviceId)} must not register`);
    }
  } finally {
    await gate.close();
  }
});

test('registers under the paired device grant and ignores a lying params deviceId', async () => {
  const { root, gateHome, pairedToken, gate } = await fixture();
  try {
    const response = await rpc(gate, pairedToken, 'notifications.register', {
      expoPushToken: 'ExponentPushToken[phone]',
      platform: 'ios',
      timezone: 'UTC',
      deviceId: 'lying-device',
    });
    assert.equal(response.status, 200);
    const stored = JSON.parse(await readFile(join(gateHome, 'push-tokens.json'), 'utf8'));
    assert.ok(stored['phone-grant']);
    assert.equal(stored['lying-device'], undefined);
    assert.equal(stored['phone-grant'].expoPushToken, 'ExponentPushToken[phone]');
    assert.equal(root === undefined, false);
  } finally {
    await gate.close();
  }
});

test('deregister deletes the calling device row', async () => {
  const { gateHome, pairedToken, gate } = await fixture();
  try {
    await rpc(gate, pairedToken, 'notifications.register', {
      expoPushToken: 'ExponentPushToken[phone]',
      platform: 'ios',
      timezone: 'UTC',
    });
    const response = await rpc(gate, pairedToken, 'notifications.deregister');
    assert.equal(response.status, 200);
    const stored = JSON.parse(await readFile(join(gateHome, 'push-tokens.json'), 'utf8'));
    assert.equal(stored['phone-grant'], undefined);
  } finally {
    await gate.close();
  }
});

test('preferences default to disabled for a paired device', async () => {
  const { pairedToken, gate } = await fixture();
  try {
    const response = await rpc(gate, pairedToken, 'notifications.preferences.get');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.enabled, false);
    assert.equal(body.result.richBody, false);
    assert.deepEqual(body.result.botIds, []);
    assert.equal(body.result.quietHours, null);
  } finally {
    await gate.close();
  }
});

test('a device can opt into widget updates, and the default is off', async () => {
  const { pairedToken, gate } = await fixture();
  try {
    const before = await (await rpc(gate, pairedToken, 'notifications.preferences.get')).json();
    assert.equal(before.result.widgetUpdates, false);
    await rpc(gate, pairedToken, 'notifications.preferences.set', { widgetUpdates: true });
    const after = await (await rpc(gate, pairedToken, 'notifications.preferences.get')).json();
    assert.equal(after.result.widgetUpdates, true);
  } finally {
    await gate.close();
  }
});

test('the approval exemption defaults to off, flips on, and rejects a non-boolean', async () => {
  const { pairedToken, gate } = await fixture();
  try {
    const before = await (await rpc(gate, pairedToken, 'notifications.preferences.get')).json();
    assert.equal(before.result.quietHoursAllowApprovals, false);
    const set = await rpc(gate, pairedToken, 'notifications.preferences.set', { quietHoursAllowApprovals: true });
    assert.equal(set.status, 200);
    const after = await (await rpc(gate, pairedToken, 'notifications.preferences.get')).json();
    assert.equal(after.result.quietHoursAllowApprovals, true);
    const bad = await rpc(gate, pairedToken, 'notifications.preferences.set', { quietHoursAllowApprovals: 'yes' });
    assert.equal(bad.status, 400);
  } finally {
    await gate.close();
  }
});

test('revoking a paired device also drops its push row', async () => {
  const { pairedToken, gate, gateHome } = await fixture();
  try {
    await rpc(gate, pairedToken, 'notifications.register', {
      expoPushToken: 'ExponentPushToken[phone]',
      platform: 'ios',
      timezone: 'UTC',
    });
    const response = await rpc(gate, gate.token, 'device.revoke', { deviceId: 'phone-grant' });
    assert.equal(response.status, 200);
    const stored = JSON.parse(await readFile(join(gateHome, 'push-tokens.json'), 'utf8'));
    assert.equal(stored['phone-grant'], undefined);
  } finally {
    await gate.close();
  }
});

test('advertises the notification methods on the manifest', async () => {
  const { gate } = await fixture();
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    for (const method of [
      'notifications.register',
      'notifications.deregister',
      'notifications.preferences.get',
      'notifications.preferences.set',
      'notifications.test',
    ]) {
      assert.ok(manifest.rpcMethods.includes(method), `${method} must be advertised`);
    }
  } finally {
    await gate.close();
  }
});

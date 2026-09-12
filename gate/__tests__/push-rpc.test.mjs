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

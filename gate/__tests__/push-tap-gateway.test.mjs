import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPushNotifier } from '../core/push-notifier.mjs';
import { createPushRpc } from '../core/push-rpc.mjs';

test('push payloads carry the registered gateway profile key without secrets', async () => {
  let row;
  const sent = [];
  const tokens = {
    upsert: async (_deviceId, patch) => {
      row = { ...row, ...patch, enabled: true };
      return row;
    },
    get: async () => row,
    remove: async () => false,
    removeByToken: async () => false,
    listEnabled: async () => [row],
  };
  const rpc = createPushRpc({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });
  await rpc['notifications.register']({
    expoPushToken: 'ExponentPushToken[secret-token]',
    profileKey: 'saved-profile-b',
    platform: 'ios',
    timezone: 'UTC',
  }, { deviceId: 'device-12345678' });
  await rpc['notifications.test']({}, { deviceId: 'device-12345678' });

  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => { sent.push(...messages); return { ok: true }; },
  });
  await notifier.notify({ trigger: 'final-response', sessionId: 'shared-session', botId: 'scout', text: 'done' });
  await notifier.notify({ trigger: 'run', runId: 'run-1', state: 'completed' });
  await notifier.notify({ trigger: 'approval', runId: 'run-2' });
  await notifier.notify({ trigger: 'routine', jobId: 'job-1', botId: 'scout' });

  assert.equal(sent.length, 5);
  assert.deepEqual(sent[0].data, { kind: 'test', gatewayKey: 'saved-profile-b' });
  assert.deepEqual(sent[1].data, {
    kind: 'reply', sessionId: 'shared-session', botId: 'scout', gatewayKey: 'saved-profile-b',
  });
  assert.deepEqual(sent[2].data, {
    kind: 'run', runId: 'run-1', gatewayKey: 'saved-profile-b',
  });
  assert.deepEqual(sent[3].data, { kind: 'approval', runId: 'run-2', gatewayKey: 'saved-profile-b' });
  assert.deepEqual(sent[4].data, { kind: 'routine', jobId: 'job-1', botId: 'scout', gatewayKey: 'saved-profile-b' });
  for (const message of sent) {
    assert.equal(message.data.expoPushToken, undefined);
    assert.equal(message.data.token, undefined);
    assert.equal(message.data.auth, undefined);
    assert.equal(message.data.url, undefined);
    assert.equal(message.to, 'ExponentPushToken[secret-token]');
  }
});

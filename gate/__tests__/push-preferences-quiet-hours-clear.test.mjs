import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPushRpc } from '../core/push-rpc.mjs';

test('preferences set can explicitly clear quiet hours while undefined leaves them alone', async () => {
  const writes = [];
  const rpc = createPushRpc({ tokens: {
    upsert: async (_id, patch) => (writes.push(patch), patch), get: async () => null, remove: async () => false,
  }, send: async () => ({}) });
  await rpc['notifications.preferences.set']({ quietHours: null }, { deviceId: 'device' });
  await rpc['notifications.preferences.set']({}, { deviceId: 'device' });
  assert.deepEqual(writes, [{ quietHours: null }, {}]);
  await assert.rejects(rpc['notifications.preferences.set']({ quietHours: {} }, { deviceId: 'device' }));
});

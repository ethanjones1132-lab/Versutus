import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollUntilAuthorized } from '../core/providers/oauth/device-code.mjs';

test('device-code polling retries unclassified transient failures but keeps OAuth denials fatal', async () => {
  let calls = 0;
  const result = await pollUntilAuthorized({ tokenEndpoint: 'unused', clientId: 'client', deviceCode: 'code', interval: 0,
    expiresIn: 2, sleep: async () => {}, fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return { ok: true, json: async () => ({ access_token: 'ok' }) };
    } });
  assert.equal(calls, 2);
  assert.equal(result.access_token, 'ok');
  await assert.rejects(pollUntilAuthorized({ tokenEndpoint: 'unused', clientId: 'client', deviceCode: 'code', interval: 0,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'access_denied' }) }) }), { code: 'access_denied' });
});

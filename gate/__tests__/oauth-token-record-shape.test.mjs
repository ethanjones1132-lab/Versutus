import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthManager } from '../core/providers/oauth/refresh.mjs';

test('token response without access_token is rejected and rotation keeps the prior refresh token', () => {
  const refresh = Object.create(OAuthManager.prototype);
  assert.throws(() => refresh.tokenRecord({ expires_in: 90 }, { refreshToken: 'prior' }), { code: 'missing_access_token' });
  const record = refresh.tokenRecord({ access_token: 'access', expires_in: 90, token_type: 'Bearer' }, { refreshToken: 'prior' });
  assert.equal(record.refreshToken, 'prior');
  assert.equal(record.tokenType, 'Bearer');
  assert.ok(record.expiresAt);
});

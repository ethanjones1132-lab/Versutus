import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { fakeOAuthIssuer } from './fixtures/oauth-issuer.mjs';
import { startDeviceAuthorization, pollDeviceToken } from '../core/providers/oauth/device-code.mjs';

test('device flow honors authorization_pending then returns tokens', async () => {
  const issuer = await fakeOAuthIssuer();
  after(() => issuer.close());
  const started = await startDeviceAuthorization({
    deviceAuthorizationEndpoint: `${issuer.issuer}/device`,
    clientId: 'public',
  });
  await assert.rejects(
    () => pollDeviceToken({
      tokenEndpoint: `${issuer.issuer}/token`,
      clientId: 'public',
      deviceCode: started.device_code,
    }),
    /authorization_pending/,
  );
  issuer.authorizeDevice();
  const tokens = await pollDeviceToken({
    tokenEndpoint: `${issuer.issuer}/token`,
    clientId: 'public',
    deviceCode: started.device_code,
  });
  assert.equal(tokens.access_token, 'access-1');
});

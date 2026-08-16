import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { fakeOAuthIssuer } from './fixtures/oauth-issuer.mjs';
import { startDeviceAuthorization, pollDeviceToken, pollUntilAuthorized } from '../core/providers/oauth/device-code.mjs';

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

test('device poll loop honors authorization_pending then returns tokens', async () => {
  const issuer = await fakeOAuthIssuer();
  after(() => issuer.close());
  const started = await startDeviceAuthorization({
    deviceAuthorizationEndpoint: `${issuer.issuer}/device`,
    clientId: 'public',
  });
  setTimeout(() => issuer.authorizeDevice(), 30);
  const tokens = await pollUntilAuthorized({
    tokenEndpoint: `${issuer.issuer}/token`,
    clientId: 'public',
    deviceCode: started.device_code,
    interval: 0.01,
    expiresIn: 2,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
  });
  assert.equal(tokens.access_token, 'access-1');
});

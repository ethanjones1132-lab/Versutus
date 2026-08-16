import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { fakeOAuthIssuer } from './fixtures/oauth-issuer.mjs';
import { discoverIssuer } from '../core/providers/oauth/discovery.mjs';

test('discovers token and device endpoints from a pinned issuer', async () => {
  const issuer = await fakeOAuthIssuer();
  after(() => issuer.close());
  const metadata = await discoverIssuer(issuer.issuer);
  assert.equal(metadata.token_endpoint, `${issuer.issuer}/token`);
  assert.equal(metadata.device_authorization_endpoint, `${issuer.issuer}/device`);
});

test('rejects discovery that leaves the issuer host', async () => {
  await assert.rejects(
    () => discoverIssuer('https://evil.example'),
    /issuer|host|pin/i,
  );
});

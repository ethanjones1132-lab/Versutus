import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeOAuthIssuer } from './fixtures/oauth-issuer.mjs';
import { OAuthManager } from '../core/providers/oauth/refresh.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function manager() {
  const issuer = await fakeOAuthIssuer();
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-oauth-'));
  const vault = new CredentialVault({
    gateHome,
    backend: {
      protect: async (plain) => Buffer.from(plain),
      unprotect: async (cipher) => Buffer.from(cipher),
    },
  });
  await vault.set('oauth/fake-oauth', JSON.stringify({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  }));
  const oauth = new OAuthManager({
    vault,
    profiles: new Map([['fake-oauth', {
      id: 'fake-oauth',
      issuer: issuer.issuer,
      clientId: 'public',
    }]]),
  });
  cleanups.push(async () => {
    await issuer.close();
    await rm(gateHome, { recursive: true, force: true });
  });
  return { oauth, issuer };
}

test('rotating refresh is single-flight and persists the newest token', async () => {
  const { oauth, issuer } = await manager();
  const [first, second] = await Promise.all([
    oauth.getAccess('fake-oauth'),
    oauth.getAccess('fake-oauth'),
  ]);
  assert.equal(issuer.refreshCalls, 1);
  assert.equal(first.accessToken, second.accessToken);
  assert.equal(first.accessToken, 'access-2');
});

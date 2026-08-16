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

test('invalid_grant deletes unusable tokens and records needs_reauth', async () => {
  const { oauth, issuer } = await manager();
  issuer.failRefreshWith('invalid_grant', 400);
  await assert.rejects(() => oauth.getAccess('fake-oauth'), /needs_reauth|invalid_grant/);
  assert.equal(await oauth.readTokens('fake-oauth'), undefined);
});

test('429 retains the grant and records a retryable failure', async () => {
  const { oauth, issuer } = await manager();
  issuer.failRefreshWith('temporarily_unavailable', 429);
  await assert.rejects(() => oauth.getAccess('fake-oauth'), /temporarily_unavailable|429/);
  const stored = await oauth.readTokens('fake-oauth');
  assert.equal(stored.refreshToken, 'refresh-1');
});

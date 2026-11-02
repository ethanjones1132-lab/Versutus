import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OAuthManager } from '../core/providers/oauth/refresh.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

// `OAuthManager.disconnect` read the stored grant first, and `readTokens` parses
// the vault value without a guard. A corrupt value therefore rejected with a
// SyntaxError before `vault.delete` ran, so the disconnect never happened and
// the unreadable grant stayed in the vault. A disconnect has to delete what it
// cannot parse; there is simply no token to revoke.

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function manager({ profiles = new Map() } = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-oauth-disconnect-'));
  const vault = new CredentialVault({
    gateHome,
    backend: {
      protect: async (plain) => Buffer.from(plain),
      unprotect: async (cipher) => Buffer.from(cipher),
    },
  });
  cleanups.push(() => rm(gateHome, { recursive: true, force: true }));
  return {
    vault,
    oauth: new OAuthManager({ vault, profiles }),
  };
}

test('disconnect deletes the grant even when the stored value is corrupt', async () => {
  const { vault, oauth } = await manager({
    profiles: new Map([['fake-oauth', {
      id: 'fake-oauth',
      issuer: 'https://issuer.invalid',
      clientId: 'public',
    }]]),
  });
  await vault.set('oauth/fake-oauth', 'BROKEN-GRANT-VALUE');

  const answer = await oauth.disconnect('fake-oauth');

  assert.deepEqual(answer, { disconnected: true, remote: false });
  assert.equal(
    await vault.get('oauth/fake-oauth'),
    undefined,
    'a grant that cannot be parsed was left behind by the disconnect',
  );
});

test('a healthy disconnect behaves as before and deletes the stored tokens', async () => {
  const { vault, oauth } = await manager();
  await vault.set('oauth/fake-oauth', JSON.stringify({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));

  const answer = await oauth.disconnect('fake-oauth');

  assert.deepEqual(answer, { disconnected: true, remote: false });
  assert.equal(await vault.get('oauth/fake-oauth'), undefined);
});

test('the corrupt value is never written to the console', async () => {
  const { vault, oauth } = await manager();
  await vault.set('oauth/fake-oauth', 'BROKEN-GRANT-VALUE');

  const written = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args) => written.push(args.join(' '));
  console.info = (...args) => written.push(args.join(' '));
  console.warn = (...args) => written.push(args.join(' '));
  console.error = (...args) => written.push(args.join(' '));
  try {
    await oauth.disconnect('fake-oauth');
  } finally {
    Object.assign(console, original);
  }

  assert.equal(
    written.some((line) => line.includes('BROKEN-GRANT-VALUE')),
    false,
    'the corrupt grant value reached the log',
  );
});

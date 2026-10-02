import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeOAuthIssuer } from './fixtures/oauth-issuer.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';
import { pollDeviceToken, pollUntilAuthorized } from '../core/providers/oauth/device-code.mjs';
import { OAuthManager } from '../core/providers/oauth/refresh.mjs';
import { createProviderAdapter } from '../core/providers/factory.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { createProviderRpc } from '../core/providers/rpc.mjs';

// Two ways the OAuth path could not reach a token:
//
//  - `providers.auth.begin` handed the phone `authorizationUrl: undefined`,
//    because `createPkceAttempt` never built one, and nothing in the Gate called
//    `consumePkceAttempt` -- so the code the browser delivered to the attempt's
//    own loopback listener was never exchanged for anything. The attempt could
//    only die on its own TTL.
//  - `refreshIfNeeded` and `pollDeviceToken` called `response.json()` BEFORE the
//    `!response.ok` test, so an HTML error page, an empty body or a proxy's
//    plain-text 502 rejected with `SyntaxError: Unexpected token '<'` and the
//    classification behind that branch never ran.

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function manager(controls = {}) {
  const issuer = await fakeOAuthIssuer(controls);
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-oauth-path-'));
  const vault = new CredentialVault({
    gateHome,
    backend: {
      protect: async (plain) => Buffer.from(plain),
      unprotect: async (cipher) => Buffer.from(cipher),
    },
  });
  const oauth = new OAuthManager({
    vault,
    profiles: new Map([['fake-oauth', { id: 'fake-oauth', issuer: issuer.issuer, clientId: 'public' }]]),
  });
  cleanups.push(async () => {
    await issuer.close();
    await rm(gateHome, { recursive: true, force: true });
  });
  return { oauth, issuer, vault, gateHome };
}

async function waitFor(read, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the OAuth exchange');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** An issuer whose token endpoint answers with a proxy's HTML error page. */
async function htmlRefusingIssuer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
      }));
      return;
    }
    req.resume();
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html><head><title>502</title></head><body>Bad Gateway</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { server, get issuer() { return `http://127.0.0.1:${server.address().port}`; } };
}

test('begin answers with a URL the phone can open', async () => {
  const { oauth, issuer } = await manager();

  const attempt = await oauth.begin('fake-oauth');

  assert.ok(attempt.authorizationUrl, 'the phone was handed undefined and has nothing to open');
  const url = new URL(attempt.authorizationUrl);
  assert.equal(url.origin + url.pathname, `${issuer.issuer}/authorize`);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'public');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), attempt.codeChallenge);
  assert.equal(url.searchParams.get('state'), attempt.state);
  assert.equal(url.searchParams.get('redirect_uri'), attempt.redirectUri);

  await attempt.close();
});

test('the code the browser delivers is exchanged, and the attempt is consumed', async () => {
  const { oauth } = await manager();

  const attempt = await oauth.begin('fake-oauth');
  // What the desktop browser does at the end of the authorization: follow the
  // redirect_uri the Gate put in the authorization URL.
  const delivered = await fetch(`${attempt.redirectUri}?code=auth-code&state=${attempt.state}`);
  assert.equal(delivered.status, 200);

  const stored = await waitFor(async () => oauth.readTokens('fake-oauth'));
  assert.equal(stored.accessToken, 'access-1');
  assert.equal(stored.refreshToken, 'refresh-1');
  assert.equal(oauth.getAttempt(attempt.id), undefined, 'the phone would keep polling a finished sign-in');
});

test('an authorization that is refused stores nothing and consumes the attempt', async () => {
  const { oauth } = await manager();

  const attempt = await oauth.begin('fake-oauth');
  const delivered = await fetch(`${attempt.redirectUri}?error=access_denied&state=${attempt.state}`);
  assert.equal(delivered.status, 200);

  await waitFor(async () => oauth.getAttempt(attempt.id) === undefined);
  await assert.rejects(async () => oauth.getAccess('fake-oauth'), /needs_reauth/);
});

test('begin refuses a provider this Gate has no OAuth profile for', async () => {
  const { oauth } = await manager();

  await assert.rejects(
    () => oauth.begin('not-configured'),
    /no OAuth profile/,
    'an attempt with no URL is a sign-in that can only time out',
  );
  assert.equal(oauth.getAttempt(oauth.attempts && 'anything'), undefined);
});

test('a refresh answered with HTML fails with the status, not a SyntaxError', async () => {
  const issuer = await htmlRefusingIssuer();
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-oauth-html-'));
  cleanups.push(() => rm(gateHome, { recursive: true, force: true }));
  const vault = new CredentialVault({
    gateHome,
    backend: { protect: async (p) => Buffer.from(p), unprotect: async (c) => Buffer.from(c) },
  });
  await vault.set('oauth/html', JSON.stringify({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  }));
  const oauth = new OAuthManager({
    vault,
    profiles: new Map([['html', { id: 'html', issuer: issuer.issuer, clientId: 'public' }]]),
  });

  const error = await oauth.getAccess('html').then(() => null, (caught) => caught);

  assert.ok(error, 'the refresh resolved, so there was nothing to classify');
  assert.notEqual(error.constructor.name, 'SyntaxError', `a JSON parse error replaced the provider's answer: ${error.message}`);
  assert.match(error.message, /502/);
  assert.ok(await oauth.readTokens('html'), 'a grant it could not classify was thrown away');
});

test('a device token poll answered with HTML fails with the status, and does not keep polling', async () => {
  const issuer = await htmlRefusingIssuer();

  const error = await pollDeviceToken({
    tokenEndpoint: `${issuer.issuer}/token`,
    clientId: 'public',
    deviceCode: 'device-1',
  }).then(() => null, (caught) => caught);

  assert.ok(error);
  assert.notEqual(error.constructor.name, 'SyntaxError', `a JSON parse error replaced the provider's answer: ${error.message}`);
  assert.match(error.message, /502/);

  const polls = [];
  const before = Date.now();
  await assert.rejects(
    () => pollUntilAuthorized({
      tokenEndpoint: `${issuer.issuer}/token`,
      clientId: 'public',
      deviceCode: 'device-1',
      interval: 0,
      expiresIn: 30,
      fetchImpl: (...args) => {
        polls.push(args);
        return pollDeviceToken({
          tokenEndpoint: `${issuer.issuer}/token`,
          clientId: 'public',
          deviceCode: 'device-1',
        });
      },
    }),
    /502/,
  );
  assert.equal(polls.length, 1, 'an unclassifiable answer was slept on like authorization_pending');
  assert.ok(Date.now() - before < 5000);
});

test('begin looks up the shipped profile by oauthProfileId and stores the token under the instance', async () => {
  const { oauth, issuer } = await manager();
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-oauth-begin-id-'));
  cleanups.push(() => rm(gateHome, { recursive: true, force: true }));
  const store = new ProviderStore(gateHome);
  await store.put({
    schemaVersion: 2,
    kind: 'provider',
    id: 'my-instance',
    label: 'Mine',
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'oauth',
      protocol: 'openai_chat',
      resourceBaseUrl: 'https://api.oidc.invalid/v1',
      oauthProfileId: 'fake-oauth',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  }, {});
  const rpc = createProviderRpc({
    service: new ProviderService({
      store,
      vault: oauth.vault,
      adapters: {
        'my-instance': {
          authenticate: async () => ({ state: 'ready' }),
          health: async () => ({ state: 'ready' }),
          listModels: async () => [],
          chat: async () => ({ choices: [] }),
        },
      },
    }),
    vault: oauth.vault,
    oauth,
  });

  const answer = await rpc['providers.auth.begin']({ id: 'my-instance' });

  assert.ok(answer.authorizationUrl, 'begin looked up the instance id against the profile map');
  const url = new URL(answer.authorizationUrl);
  assert.equal(url.origin + url.pathname, `${issuer.issuer}/authorize`);

  const attempt = oauth.getAttempt(answer.attemptId);
  const delivered = await fetch(`${attempt.redirectUri}?code=auth-code&state=${attempt.state}`);
  assert.equal(delivered.status, 200);

  const stored = await waitFor(async () => oauth.readTokens('my-instance'));
  assert.equal(stored.accessToken, 'access-1');
  assert.equal(
    await oauth.readTokens('fake-oauth'),
    undefined,
    'the token was stored under the profile id, so a second instance would share it',
  );
});

async function loopbackModelsServer(seen) {
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function oauthInstanceConfig(origin) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id: 'chat-instance',
    label: 'Chat',
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'oauth',
      protocol: 'openai_chat',
      resourceBaseUrl: `${origin}/v1`,
      oauthProfileId: 'fake-oauth',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

test('an oauth adapter sends Bearer <accessToken>, not the token record', async () => {
  const { oauth, vault } = await manager();
  const seen = [];
  const origin = await loopbackModelsServer(seen);

  // Still valid, so getAccess returns the stored record without refreshing.
  // The record is `{accessToken, refreshToken, ...}`; interpolating it is
  // `Bearer [object Object]`.
  await vault.set('oauth/chat-instance', JSON.stringify({
    accessToken: 'access-token-live',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenType: 'Bearer',
  }));

  const adapter = createProviderAdapter(oauthInstanceConfig(origin), {
    vault,
    store: { get: async () => null },
    oauth,
  });

  await adapter.listModels();

  assert.equal(seen.length, 1, 'the catalog probe never reached the vendor');
  assert.equal(seen[0].authorization, 'Bearer access-token-live');
  assert.notEqual(
    seen[0].authorization,
    'Bearer [object Object]',
    'getAccess returns a record and the adapter sent the record as the bearer secret',
  );
});

test('an expired oauth grant refreshes through oauthProfileId, not the instance id', async () => {
  const { oauth, vault } = await manager();
  const seen = [];
  const origin = await loopbackModelsServer(seen);

  await vault.set('oauth/chat-instance', JSON.stringify({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    tokenType: 'Bearer',
  }));

  const adapter = createProviderAdapter(oauthInstanceConfig(origin), {
    vault,
    store: { get: async () => null },
    oauth,
  });

  await adapter.listModels();

  assert.equal(seen.length, 1, 'refresh looked up the instance id in the profile map');
  assert.equal(seen[0].authorization, 'Bearer access-2');
});

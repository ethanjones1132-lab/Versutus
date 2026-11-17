import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { handlePairingPage } from '../core/routes/pairing-page.mjs';
import { PairingStore } from '../core/pairing.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';
import { handlePublicRoute } from '../core/routes/public.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-pairing-page-'));
  return {
    pairing: new PairingStore(join(dir, 'pairing.json')),
    deviceTokens: new DeviceTokenStore(join(dir, 'device-tokens.json')),
  };
}

function request({ method = 'GET', url = '/pair', address = '127.0.0.1', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost:8760', ...headers };
  req.socket = { remoteAddress: address };
  return req;
}

function response() {
  const res = new EventEmitter();
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (body = '') => { res.body = String(body); };
  return res;
}

async function getPage({ pairing, deviceTokens }, options = {}) {
  const res = response();
  await handlePairingPage({
    req: request(options),
    res,
    pathname: '/pair',
    method: 'GET',
    pairing,
    deviceTokens,
    port: 8760,
  });
  return res;
}

async function post({ pairing, deviceTokens }, action, body, headers = {}) {
  const res = response();
  await handlePairingPage({
    req: request({
      method: 'POST',
      url: `/pair/${action}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
    }),
    res,
    pathname: `/pair/${action}`,
    method: 'POST',
    pairing,
    deviceTokens,
    port: 8760,
  });
  return res;
}

function csrf(page) {
  return page.body.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
}

async function addRequest(pairing, deviceId = 'phone-12345678') {
  return await pairing.addPending({
    deviceId,
    publicKeyB64Url: 'public-key-must-not-render',
    clientId: 'versutus-mobile',
    name: 'Ethan’s phone',
    model: 'Pixel',
    role: 'operator',
    scopes: ['chat:send'],
  });
}

test('loopback GET lists a pending phone without exposing credentials or tokens', async () => {
  const state = await fixture();
  await addRequest(state.pairing);
  const page = await getPage(state);

  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Ethan’s phone/);
  assert.match(page.body, /Pixel/);
  assert.match(page.body, /phone-12/);
  assert.match(page.body, /Approve/);
  assert.match(page.body, /Deny/);
  assert.match(page.body, /pairing window is closed/i);
  assert.doesNotMatch(page.body, /public-key-must-not-render/);
  // The page's own CSRF token (64 hex chars) is expected; nothing else that
  // looks like a device token or key may appear.
  const withoutCsrf = page.body.replace(/name="csrf" value="[a-f0-9]{64}"/g, 'name="csrf" value=""');
  assert.doesNotMatch(withoutCsrf, /[A-Za-z0-9_-]{43}/);
  assert.match(page.body, /http-equiv="refresh" content="3"/);
  assert.ok(csrf(page));
});

test('non-loopback and forwarded requests are forbidden', async () => {
  const state = await fixture();
  const remote = await getPage(state, { address: '192.168.1.20' });
  assert.equal(remote.statusCode, 403);
  const forwarded = await getPage(state, { headers: { 'x-forwarded-for': '127.0.0.1' } });
  assert.equal(forwarded.statusCode, 403);
  const standardForwarded = await getPage(state, { headers: { forwarded: 'for=127.0.0.1' } });
  assert.equal(standardForwarded.statusCode, 403);
});

// DNS rebinding: a page whose domain now resolves to 127.0.0.1 reaches the Gate
// over loopback from the PC's own browser, with its own Host. The socket alone
// cannot tell, so the Host must be loopback too; proxies say so in headers.
test('a loopback socket with a non-loopback Host, or a proxy header, is forbidden', async () => {
  const state = await fixture();
  for (const host of ['evil.example:8760', 'ethanspc.tail3a.ts.net:8760', '192.168.1.20:8760']) {
    const rebound = await getPage(state, { headers: { host } });
    assert.equal(rebound.statusCode, 403, host);
  }
  for (const headers of [{ 'x-real-ip': '10.0.0.5' }, { 'tailscale-user-login': 'someone@example.com' }]) {
    const proxied = await getPage(state, { headers });
    assert.equal(proxied.statusCode, 403, JSON.stringify(headers));
  }
  for (const host of ['localhost:8760', '127.0.0.1:8760', '[::1]:8760']) {
    const ok = await getPage(state, { headers: { host } });
    assert.equal(ok.statusCode, 200, host);
  }
});

test('approve refuses missing or incorrect CSRF tokens without changing pending state', async () => {
  const state = await fixture();
  const requestId = await addRequest(state.pairing);
  const noToken = await post(state, 'approve', `requestId=${requestId}`);
  const wrongToken = await post(state, 'approve', `csrf=${'0'.repeat(64)}&requestId=${requestId}`);

  assert.equal(noToken.statusCode, 403);
  assert.equal(wrongToken.statusCode, 403);
  assert.equal((await state.pairing.listPending()).length, 1);
  assert.deepEqual(await state.deviceTokens.list(), []);
});

test('valid CSRF approval issues a device grant, available to the phone access route only', async () => {
  const state = await fixture();
  const requestId = await addRequest(state.pairing);
  const page = await getPage(state);
  const token = csrf(page);
  assert.ok(token);
  const approved = await post(
    state,
    'approve',
    new URLSearchParams({ csrf: token, requestId }).toString(),
    { origin: 'http://localhost:8760', 'sec-fetch-site': 'same-origin' },
  );

  assert.equal(approved.statusCode, 303);
  assert.deepEqual(await state.pairing.listPending(), []);
  const grants = await state.deviceTokens.list();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].deviceId, 'phone-12345678');

  let status;
  let body;
  await handlePublicRoute({
    req: { url: '/.well-known/gateway/access', headers: {} },
    res: {
      writeHead(code) { status = code; },
      end(value) { body = value; },
    },
    pathname: '/.well-known/gateway/access',
    method: 'POST',
    pairing: state.pairing,
    deviceTokens: state.deviceTokens,
    verifySignedAccessRequest: () => ({ ok: true }),
    readJsonBody: async () => ({
      device: { id: 'phone-12345678', publicKey: 'phone-key' },
      signature: 'signature',
      signedAtMs: Date.now(),
      role: 'operator',
      scopes: ['chat:send'],
    }),
  });
  const phoneAnswer = JSON.parse(body);
  assert.equal(status, 200);
  assert.equal(phoneAnswer.status, 'granted');
  assert.equal(phoneAnswer.token, grants[0].token);

  const refreshedPage = await getPage(state);
  assert.doesNotMatch(refreshedPage.body, new RegExp(grants[0].token));
});

test('deny removes a pending request without issuing a device token', async () => {
  const state = await fixture();
  const requestId = await addRequest(state.pairing);
  const page = await getPage(state);
  const denied = await post(
    state,
    'deny',
    new URLSearchParams({ csrf: csrf(page), requestId }).toString(),
    { origin: 'http://localhost:8760' },
  );

  assert.equal(denied.statusCode, 303);
  assert.deepEqual(await state.pairing.listPending(), []);
  assert.deepEqual(await state.deviceTokens.list(), []);
});

test('same-origin checks reject cross-site POSTs even when the token is valid', async () => {
  const state = await fixture();
  const requestId = await addRequest(state.pairing);
  const page = await getPage(state);
  const denied = await post(
    state,
    'approve',
    new URLSearchParams({ csrf: csrf(page), requestId }).toString(),
    { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  );

  assert.equal(denied.statusCode, 403);
  assert.equal((await state.pairing.listPending()).length, 1);
});

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

// Every scope a fresh Versutus pairing asks for: the acting scopes from the
// Gate's DEVICE_ACT_SCOPES/DEVICE_RPC_SCOPES tables plus the two read scopes.
const ALL_KNOWN_SCOPES = [
  'chat:send', 'chat:read', 'runs:start', 'runs:read', 'terminal:use', 'sessions:manage',
  'providers:manage', 'environments:manage', 'routines:manage', 'capabilities:manage',
  'devices:manage', 'voice:manage', 'bots:manage',
];

function accessBody(overrides = {}) {
  return {
    device: { id: 'phone-window', publicKey: 'phone-key', clientId: 'versutus-mobile' },
    signature: 'signature',
    signedAtMs: Date.now(),
    role: 'operator',
    scopes: ['chat:send'],
    ...overrides,
  };
}

async function access(state, body) {
  let status;
  let payload;
  await handlePublicRoute({
    req: { url: '/.well-known/gateway/access', headers: {} },
    res: {
      writeHead(code) { status = code; },
      end(value) { payload = value; },
    },
    pathname: '/.well-known/gateway/access',
    method: 'POST',
    pairing: state.pairing,
    deviceTokens: state.deviceTokens,
    verifySignedAccessRequest: () => ({ ok: true }),
    readJsonBody: async () => body,
  });
  return { status, body: JSON.parse(payload) };
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

test('a pending row shows the role, a count and every scope, and Approve issues exactly the clamped set', async () => {
  const state = await fixture();
  const requestId = await state.pairing.addPending({
    deviceId: 'phone-full',
    publicKeyB64Url: 'public-key-must-not-render',
    clientId: 'versutus-mobile',
    name: 'Ethan’s phone',
    model: 'Pixel',
    role: 'operator',
    scopes: [...ALL_KNOWN_SCOPES, 'root:everything'],
  });

  const page = await getPage(state);
  // The count carries the breadth in one phrase, before the list.
  assert.match(page.body, /13 scopes — full operator/);
  for (const scope of ALL_KNOWN_SCOPES) {
    assert.ok(page.body.includes(scope), `the row must name ${scope}`);
  }
  // Acting scopes carry the plain words of the Gate's own tables.
  assert.match(page.body, /open a shell/);
  assert.match(page.body, /send a chat turn/);
  assert.match(page.body, /revoke a paired device/);
  // The unknown scope is trimmed, not rendered, and the row says so.
  assert.doesNotMatch(page.body, /root:everything/);
  assert.match(page.body, /trimmed/i);

  const approved = await post(
    state,
    'approve',
    new URLSearchParams({ csrf: csrf(page), requestId }).toString(),
    { origin: 'http://localhost:8760' },
  );
  assert.equal(approved.statusCode, 303);
  const grants = await state.deviceTokens.list();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].role, 'operator');
  assert.deepEqual(grants[0].scopes, ALL_KNOWN_SCOPES);
});

test('a role the Gate does not know is refused at approve, and the request stays for the operator', async () => {
  const state = await fixture();
  const rootId = await state.pairing.addPending({
    deviceId: 'phone-root', publicKeyB64Url: 'key', clientId: 'versutus-mobile', role: 'root', scopes: ['chat:send'],
  });
  const emptyId = await state.pairing.addPending({
    deviceId: 'phone-empty-role', publicKeyB64Url: 'key', clientId: 'versutus-mobile', role: '', scopes: [],
  });

  const page = await getPage(state);
  assert.match(page.body, /does not know this role/i);
  assert.match(page.body, /Approve will refuse/);

  const token = csrf(page);
  for (const requestId of [rootId, emptyId]) {
    const refused = await post(
      state,
      'approve',
      new URLSearchParams({ csrf: token, requestId }).toString(),
      { origin: 'http://localhost:8760' },
    );
    assert.equal(refused.statusCode, 403, requestId);
  }
  assert.deepEqual(await state.deviceTokens.list(), []);
  assert.equal((await state.pairing.listPending()).length, 2, 'a refused approve must not consume the request');
});

test('the open-window grant is clamped at the Gate and refuses an unknown role', async () => {
  const state = await fixture();
  await state.pairing.openWindow(60_000);

  const granted = await access(state, accessBody({ scopes: [...ALL_KNOWN_SCOPES, 'root:everything'] }));
  assert.equal(granted.status, 200);
  assert.equal(granted.body.status, 'granted');
  assert.equal(granted.body.role, 'operator');
  assert.deepEqual(granted.body.scopes, ALL_KNOWN_SCOPES);
  const grants = await state.deviceTokens.list();
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].scopes, ALL_KNOWN_SCOPES);

  const deduped = await access(state, accessBody({
    device: { id: 'phone-dupes', publicKey: 'phone-key', clientId: 'versutus-mobile' },
    scopes: ['runs:read', 'chat:send', 'runs:read'],
  }));
  assert.equal(deduped.status, 200);
  assert.deepEqual(deduped.body.scopes, ['runs:read', 'chat:send'], 'order is kept and duplicates collapse');

  for (const role of ['root', '']) {
    const refused = await access(state, accessBody({
      device: { id: `phone-${role || 'empty'}`, publicKey: 'phone-key', clientId: 'versutus-mobile' },
      role,
      scopes: ['chat:send'],
    }));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.status, 'denied');
  }
  assert.equal((await state.deviceTokens.list()).length, 2, 'no grant rides an unknown role');
});

test('a closed-window request is queued clamped, and one that asked for nothing grants nothing', async () => {
  const state = await fixture();

  const queued = await access(state, accessBody({ scopes: [...ALL_KNOWN_SCOPES, 'root:everything'] }));
  assert.equal(queued.status, 202);
  const [pending] = await state.pairing.listPending();
  assert.equal(pending.role, 'operator');
  assert.deepEqual(pending.scopes, ALL_KNOWN_SCOPES);

  const nothing = await access(state, accessBody({
    device: { id: 'phone-nothing', publicKey: 'phone-key', clientId: 'versutus-mobile' },
    scopes: [],
  }));
  assert.equal(nothing.status, 202);
  const emptyPending = (await state.pairing.listPending()).find((entry) => entry.deviceId === 'phone-nothing');
  assert.deepEqual(emptyPending.scopes, [], 'asking for nothing stays a grant of nothing');

  const page = await getPage(state);
  const approved = await post(
    state,
    'approve',
    new URLSearchParams({ csrf: csrf(page), requestId: nothing.body.requestId }).toString(),
    { origin: 'http://localhost:8760' },
  );
  assert.equal(approved.statusCode, 303);
  const grant = (await state.deviceTokens.list()).find((entry) => entry.deviceId === 'phone-nothing');
  assert.deepEqual(grant.scopes, []);
});

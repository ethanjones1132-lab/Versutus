import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handlePublicRoute } from '../core/routes/public.mjs';

function response() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function request(body) {
  return { body };
}

function context(overrides = {}) {
  return {
    req: request(null),
    res: response(),
    pathname: '/health',
    method: 'GET',
    state: { manifest: { manifest: 'versutus-gateway/v1', kind: 'versutus-gate' } },
    replayCache: {},
    deviceTokens: { async list() { return []; }, async issue() { return 'issued-tk'; } },
    pairing: {
      async isWindowOpen() { return false; },
      async addPending() { return 'request-1'; },
      async listPending() { return []; },
    },
    verifySignedAccessRequest() { return { ok: true }; },
    async readJsonBody(req, options) {
      assert.equal(options.maxBytes, 16 * 1024);
      return req.body;
    },
    ...overrides,
  };
}

async function postAccess(overrides = {}) {
  const ctx = context({ pathname: '/.well-known/gateway/access', method: 'POST', ...overrides });
  assert.equal(await handlePublicRoute(ctx), true);
  return ctx.res;
}

test('health and manifest routes answer with their public bodies', async () => {
  const health = context();
  assert.equal(await handlePublicRoute(health), true);
  assert.equal(health.res.status, 200);
  const healthBody = JSON.parse(health.res.body);
  assert.equal(healthBody.status, 'ok');
  assert.equal(Number.isNaN(Date.parse(healthBody.timestamp)), false);

  const manifest = context({ pathname: '/.well-known/gateway.json' });
  assert.equal(await handlePublicRoute(manifest), true);
  assert.equal(manifest.res.status, 200);
  assert.deepEqual(JSON.parse(manifest.res.body), manifest.state.manifest);
});

test('malformed access requests and invalid signatures are denied', async () => {
  const malformed = await postAccess({ req: request({ device: { id: 'device-1' } }) });
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.body), { status: 'denied', reason: 'Malformed access request.' });

  const invalid = await postAccess({
    req: request({ device: { id: 'device-1', publicKey: 'key' }, signature: 'bad', signedAtMs: 1 }),
    verifySignedAccessRequest() { return { ok: false, reason: 'signature does not match the payload' }; },
  });
  assert.equal(invalid.status, 403);
  assert.deepEqual(JSON.parse(invalid.body), { status: 'denied', reason: 'signature does not match the payload' });
});

test('a verified request is granted during the pairing window and queued otherwise', async () => {
  const body = { device: { id: 'device-1', publicKey: 'key', clientId: 'mobile' }, signature: 'sig', signedAtMs: 1, scopes: ['chat:read'] };
  const granted = await postAccess({
    req: request(body),
    pairing: { ...context().pairing, async isWindowOpen() { return true; } },
  });
  assert.equal(granted.status, 200);
  assert.deepEqual(JSON.parse(granted.body), { status: 'granted', token: 'issued-tk', role: 'operator', scopes: ['chat:read'] });

  const pending = await postAccess({ req: request(body) });
  assert.equal(pending.status, 202);
  assert.deepEqual(JSON.parse(pending.body), { status: 'pending', requestId: 'request-1' });
});

test('replayed requests never reissue a grant and remain idempotently pending', async () => {
  const body = { device: { id: 'device-1', publicKey: 'key' }, signature: 'sig', signedAtMs: 1 };
  const replayVerification = () => ({ ok: false, replay: true, reason: 'signature already used (replay)' });

  const grantedReplay = await postAccess({
    req: request(body),
    verifySignedAccessRequest: replayVerification,
    deviceTokens: { async list() { return [{ deviceId: 'device-1', token: 'existing', role: 'operator', scopes: [], revoked: false }]; } },
  });
  assert.equal(grantedReplay.status, 409);
  assert.deepEqual(JSON.parse(grantedReplay.body), {
    status: 'signature-used',
    reason: 'This signed request was already answered. Sign a fresh request.',
  });

  const pendingReplay = await postAccess({
    req: request(body),
    verifySignedAccessRequest: replayVerification,
    pairing: { ...context().pairing, async listPending() { return [{ deviceId: 'device-1', requestId: 'pending-1' }]; } },
  });
  assert.equal(pendingReplay.status, 202);
  assert.deepEqual(JSON.parse(pendingReplay.body), { status: 'pending', requestId: 'pending-1' });
});

test('unmatched paths and methods are left for later dispatch', async () => {
  assert.equal(await handlePublicRoute(context({ pathname: '/health', method: 'POST' })), false);
});

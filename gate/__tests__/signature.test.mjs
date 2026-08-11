import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { buildSignedPayload, verifySignedAccessRequest } from '../core/signature.mjs';

/** Node-only Ed25519 fixture — no dependency on the app's signing library. */
function fixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64Url = der.subarray(der.length - 32).toString('base64url');

  const request = {
    deviceId: 'device-1',
    publicKeyB64Url,
    clientId: 'versutus-mobile',
    role: 'operator',
    scopes: ['chat:send', 'chat:read'],
    signedAtMs: Date.now(),
    ...overrides,
  };
  const payload = buildSignedPayload(request);
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');
  return { request: { ...request, signature }, privateKey };
}

test('accepts a correctly signed, fresh request', () => {
  const { request } = fixture();
  const result = verifySignedAccessRequest(request, { now: request.signedAtMs });
  assert.equal(result.ok, true);
});

test('rejects a tampered field', () => {
  const { request } = fixture();
  const tampered = { ...request, role: 'admin' };
  const result = verifySignedAccessRequest(tampered, { now: tampered.signedAtMs });
  assert.equal(result.ok, false);
});

test('rejects a signature outside the clock-skew window', () => {
  const { request } = fixture();
  const farFuture = request.signedAtMs + 301_000;
  const result = verifySignedAccessRequest(request, { now: farFuture, maxSkewMs: 300_000 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /skew/);
});

test('rejects a signature already used within the replay window', () => {
  const { request } = fixture();
  const replayCache = new Set();
  const first = verifySignedAccessRequest(request, { now: request.signedAtMs, replayCache });
  const second = verifySignedAccessRequest(request, { now: request.signedAtMs, replayCache });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.reason, /replay|already used/);
});

test('rejects a malformed public key rather than throwing', () => {
  const { request } = fixture({ publicKeyB64Url: 'not-a-key' });
  const result = verifySignedAccessRequest(request, { now: request.signedAtMs });
  assert.equal(result.ok, false);
});

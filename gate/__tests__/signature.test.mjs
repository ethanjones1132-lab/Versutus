import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { buildSignedPayload, deriveDeviceId, verifySignedAccessRequest, ReplayCache } from '../core/signature.mjs';

/** Node-only Ed25519 fixture — no dependency on the app's signing library. */
function fixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64Url = der.subarray(der.length - 32).toString('base64url');

  const request = {
    deviceId: deriveDeviceId(publicKeyB64Url),
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

test('derives a device id the way the app does: sha256 of the raw key, hex', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  const derived = deriveDeviceId(raw.toString('base64url'));
  assert.equal(derived, createHash('sha256').update(raw).digest('hex'));
  assert.match(derived, /^[0-9a-f]{64}$/);
});

test('rejects a request whose device id is not derived from its public key', () => {
  // A key signs a fresh, well-formed payload that names another device's id.
  const victim = fixture();
  const attacker = fixture({ deviceId: victim.request.deviceId });
  const result = verifySignedAccessRequest(attacker.request, { now: attacker.request.signedAtMs });
  assert.equal(result.ok, false);
  assert.match(result.reason, /device id/);
  assert.notEqual(result.replay, true, 'a mismatched key never reaches the replay branch');
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
  assert.equal(second.replay, true);
});

test('rejects a malformed public key rather than throwing', () => {
  const { request } = fixture({ publicKeyB64Url: 'not-a-key' });
  const result = verifySignedAccessRequest(request, { now: request.signedAtMs });
  assert.equal(result.ok, false);
});

test('a ReplayCache rejects a duplicate signature within the window', () => {
  const { request } = fixture();
  const replayCache = new ReplayCache();
  const first = verifySignedAccessRequest(request, { now: request.signedAtMs, replayCache });
  const second = verifySignedAccessRequest(request, { now: request.signedAtMs, replayCache });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.reason, /replay|already used/);
  assert.equal(second.replay, true);
});

test('a ReplayCache entry expires after the skew window', async () => {
  const { request } = fixture();
  const replayCache = new ReplayCache({ maxSkewMs: 10 });
  const first = verifySignedAccessRequest(request, { now: request.signedAtMs, replayCache });
  assert.equal(first.ok, true);
  assert.equal(replayCache.has(request.signature), true);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(replayCache.has(request.signature), false, 'the expired entry is pruned');

  // A signature past its window is a fresh request again, not a replay.
  const after = verifySignedAccessRequest(request, { now: request.signedAtMs, replayCache });
  assert.equal(after.ok, true);
});

test('a ReplayCache is capped, evicting the oldest entries', () => {
  const replayCache = new ReplayCache({ limit: 3 });
  for (const signature of ['sig-1', 'sig-2', 'sig-3', 'sig-4']) {
    replayCache.add(signature);
  }
  assert.equal(replayCache.has('sig-1'), false, 'the oldest entry is evicted');
  assert.equal(replayCache.has('sig-2'), true);
  assert.equal(replayCache.has('sig-4'), true);
});

test('a ReplayCache prunes expired entries on add', async () => {
  const replayCache = new ReplayCache({ maxSkewMs: 10 });
  replayCache.add('stale-sig');
  await new Promise((resolve) => setTimeout(resolve, 30));
  replayCache.add('fresh-sig');
  assert.equal(replayCache.has('stale-sig'), false, 'the expired entry was pruned by add');
  assert.equal(replayCache.has('fresh-sig'), true);
});

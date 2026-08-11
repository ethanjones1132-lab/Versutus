import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// Fixed ASN.1 SPKI header for a 32-byte raw Ed25519 public key. Node's
// crypto module has no "raw" import format for OKP keys, so a bare public
// key has to be wrapped in this DER envelope before crypto.createPublicKey
// will accept it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromB64Url(b64url) {
  const raw = Buffer.from(b64url, 'base64url');
  if (raw.length !== 32) throw new Error('public key must decode to 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** The exact string the app signs — see src/lib/portal/access.ts. */
export function buildSignedPayload({ deviceId, clientId, role, scopes, signedAtMs }) {
  return ['v4', deviceId, clientId, role, scopes.join(','), String(signedAtMs)].join('|');
}

/**
 * Verify a signed access request from the app's device-pairing handshake.
 *
 * Rejects a payload whose `signedAtMs` is more than `maxSkewMs` from `now` in
 * either direction, and — when a `replayCache` is supplied — rejects a
 * signature already seen. Never throws: a malformed key or signature is a
 * verification failure, not a crash.
 */
export function verifySignedAccessRequest(request, { now = Date.now(), maxSkewMs = 300_000, replayCache } = {}) {
  const { deviceId, publicKeyB64Url, clientId, role, scopes, signedAtMs, signature } = request;

  if (typeof signedAtMs !== 'number' || Math.abs(now - signedAtMs) > maxSkewMs) {
    return { ok: false, reason: 'signedAtMs is outside the allowed clock skew' };
  }

  if (replayCache?.has(signature)) {
    return { ok: false, reason: 'signature already used (replay)' };
  }

  let publicKey;
  try {
    publicKey = publicKeyFromB64Url(publicKeyB64Url);
  } catch (error) {
    return { ok: false, reason: `invalid public key: ${error.message}` };
  }

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'signature is not valid base64url' };
  }

  const message = Buffer.from(buildSignedPayload({ deviceId, clientId, role, scopes, signedAtMs }), 'utf8');

  let valid;
  try {
    valid = cryptoVerify(null, message, publicKey, signatureBytes);
  } catch {
    valid = false;
  }

  if (!valid) return { ok: false, reason: 'signature does not match the payload' };

  replayCache?.add(signature);
  return { ok: true };
}

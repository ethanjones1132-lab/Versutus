import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.VERSUTUS_CLI_TOKEN_SECRET || randomBytes(32).toString('hex');

/**
 * Nonces already spent, with the instant each token expires. A replay is only
 * meaningful inside the token's own lifetime — once the token would verify as
 * `expired` anyway, holding its nonce protects nothing — so entries are dropped
 * as they expire. The hard cap is the backstop for a caller that verifies with
 * a clock far behind the one it issued with, which would keep every entry alive.
 * Map order is insertion order, so the cap sheds the oldest first.
 */
const MAX_SEEN_TOKENS = 10_000;
const seen = new Map();

function pruneSeen(now) {
  for (const [nonce, expiresAtMs] of seen) {
    if (expiresAtMs <= now) seen.delete(nonce);
  }
  while (seen.size > MAX_SEEN_TOKENS) {
    seen.delete(seen.keys().next().value);
  }
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function sign(payload) {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function issueInvocationToken(request, { now = Date.now(), ttlMs = 10 * 60_000 } = {}) {
  const claims = {
    environmentId: request.environmentId,
    runId: request.runId,
    // Optional: a status or inspection run references no model. Dereferencing
    // this unconditionally surfaced a TypeError as a 409 "run_failed".
    providerId: request.providerRef?.providerId,
    modelId: request.providerRef?.modelId,
    endpoints: request.endpoints,
    audience: request.audience || 'versutus-gate',
    exp: now + ttlMs,
    iat: now,
    nonce: randomBytes(16).toString('hex'),
  };
  const payload = encode(claims);
  const token = `${payload}.${sign(payload)}`;
  return { token, claims };
}

export function verifyInvocationToken(token, { audience, runId, now = Date.now() } = {}) {
  try {
    const [payload, signature] = String(token).split('.');
    const expected = sign(payload);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return { ok: false, code: 'invalid_signature' };
    }
    const claims = decode(payload);
    if (audience && claims.audience !== audience) {
      return { ok: false, code: 'wrong_audience' };
    }
    if (runId && claims.runId !== runId) {
      return { ok: false, code: 'wrong_run' };
    }
    if (claims.exp <= now) {
      return { ok: false, code: 'expired' };
    }
    pruneSeen(now);
    if (seen.has(claims.nonce)) {
      return { ok: false, code: 'replay' };
    }
    seen.set(claims.nonce, typeof claims.exp === 'number' ? claims.exp : 0);
    return { ok: true, claims };
  } catch {
    return { ok: false, code: 'invalid_token' };
  }
}

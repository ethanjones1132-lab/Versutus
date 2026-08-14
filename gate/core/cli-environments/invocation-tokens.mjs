import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.VERSUTUS_CLI_TOKEN_SECRET || randomBytes(32).toString('hex');
const seen = new Set();

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
    providerId: request.providerRef.providerId,
    modelId: request.providerRef.modelId,
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
    if (seen.has(claims.nonce)) {
      return { ok: false, code: 'replay' };
    }
    seen.add(claims.nonce);
    return { ok: true, claims };
  } catch {
    return { ok: false, code: 'invalid_token' };
  }
}

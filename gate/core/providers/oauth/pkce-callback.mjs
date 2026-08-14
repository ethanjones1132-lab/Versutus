import { createHash, randomBytes } from 'node:crypto';

export async function createPkceAttempt(store, { providerId, ttlMs = 10 * 60_000 } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const port = 49152 + Math.floor(Math.random() * 14000);
  const attempt = {
    id: randomBytes(16).toString('hex'),
    providerId,
    state: randomBytes(16).toString('hex'),
    codeVerifier: verifier,
    codeChallenge: challenge,
    redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
    expiresAt: Date.now() + ttlMs,
    used: false,
  };
  store.put(attempt);
  return attempt;
}

export function consumePkceAttempt(store, attemptId, state) {
  const attempt = store.get(attemptId);
  if (!attempt || attempt.used) throw new Error('unknown or one-use attempt');
  if (attempt.state !== state) throw new Error('state mismatch');
  if (Date.now() > attempt.expiresAt) throw new Error('attempt expired');
  attempt.used = true;
  store.delete(attemptId);
  return attempt;
}

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export async function createPkceAttempt(store, { providerId, ttlMs = 10 * 60_000 } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const attempt = {
    id: randomBytes(16).toString('hex'),
    providerId,
    state: randomBytes(16).toString('hex'),
    codeVerifier: verifier,
    codeChallenge: challenge,
    expiresAt: Date.now() + ttlMs,
    used: false,
  };

  let settled = false;
  let resolveCallback;
  let rejectCallback;
  attempt.callback = new Promise((resolve, reject) => {
    resolveCallback = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectCallback = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    const received = {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
    };
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(received.error ? 'Authorization failed' : 'Authorization complete');
    resolveCallback(received);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  attempt.redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  attempt.server = server;
  const timeout = setTimeout(() => {
    rejectCallback(new Error('attempt expired'));
  }, ttlMs);
  timeout.unref?.();
  attempt.callback.catch(() => {});

  attempt.close = () => new Promise((resolve) => {
    clearTimeout(timeout);
    server.close(() => resolve());
  });

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

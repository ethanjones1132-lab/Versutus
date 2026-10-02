import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export async function createPkceAttempt(
  store,
  { providerId, authorizationEndpoint, clientId, scope = 'openid', ttlMs = 10 * 60_000 } = {},
) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // Validated before the loopback listener exists, so a malformed endpoint
  // cannot leave one listening with nothing that will ever close it.
  const authorizationUrl = authorizationEndpoint ? new URL(authorizationEndpoint) : null;
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
  let delivered = false;
  let resolveCallback;
  let rejectCallback;
  attempt.callback = new Promise((resolve, reject) => {
    resolveCallback = (value) => {
      if (settled) return;
      settled = true;
      delivered = true;
      resolve(value);
    };
    rejectCallback = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });

  /**
   * End the attempt for good: the timer stops, the loopback listener closes and
   * the attempt leaves the store, so an attempt nobody finished in time costs
   * nothing after it expires. Three things can reach it — the expiry timer, the
   * one callback it exists to receive, and an explicit `close()` — and all three
   * may arrive, so it is idempotent and never throws.
   */
  let released = null;
  const release = () => {
    if (released) return released;
    clearTimeout(timeout);
    released = new Promise((resolve) => {
      try {
        server.close(() => resolve());
        // `close` only stops new connections; the browser that just ran the
        // callback is still holding the one this attempt answered on.
        server.closeAllConnections?.();
      } catch {
        resolve();
      }
    });
    // Only while a code was actually delivered. A delivered code still has to
    // be read off this attempt by `consumePkceAttempt`, and this teardown runs
    // on the `res.end` callback -- which Node schedules on `process.nextTick`,
    // ahead of the promise continuation that consumes it. Deleting the entry
    // here anyway raced that consume and answered every authorization the
    // browser completed with "unknown or one-use attempt", so nothing was ever
    // exchanged. `setImmediate` closes the window and still removes an attempt
    // nobody ever consumed. An expiry or a `close` delivered no code, so it
    // leaves the store at once.
    if (delivered) setImmediate(() => store.delete(attempt.id));
    else store.delete(attempt.id);
    return released;
  };

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
    res.end(received.error ? 'Authorization failed' : 'Authorization complete', () => {
      // The callback has been served, so the loopback listener this attempt
      // opened has nothing left to answer — closed once the response it wrote
      // is on the wire, so the browser is not reading from a socket being torn
      // down under it.
      void release();
    });
    resolveCallback(received);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  attempt.redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  // The URL the browser is actually sent to, built here because only here do the
  // challenge and the state exist. `providers.auth.begin` hands this straight to
  // the phone, so an attempt that did not carry one answered `undefined` -- the
  // sheet opened with nothing to follow and the sign-in could only die on this
  // attempt's TTL.
  if (authorizationUrl) {
    authorizationUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId ?? '',
      redirect_uri: attempt.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: attempt.state,
      scope,
    });
    attempt.authorizationUrl = authorizationUrl.toString();
  }
  attempt.server = server;
  const timeout = setTimeout(() => {
    rejectCallback(new Error('attempt expired'));
    void release();
  }, ttlMs);
  timeout.unref?.();
  attempt.callback.catch(() => {});

  attempt.close = () => release();

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

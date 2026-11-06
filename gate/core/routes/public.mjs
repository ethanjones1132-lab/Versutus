// The unauthenticated access endpoint gets a tight body cap: anyone who can
// reach the port can POST to it, and a signed access request is a few hundred
// bytes. Authenticated routes keep their own, generous cap in server.mjs.
export const ACCESS_MAX_BODY_BYTES = 16 * 1024;

export async function handlePublicRoute({
  req,
  res,
  pathname,
  method,
  state,
  replayCache,
  deviceTokens,
  pairing,
  verifySignedAccessRequest,
  readJsonBody,
}) {
  // Health endpoint (unauthenticated). Also served under each provider
  // base path so a child profile whose baseUrl is /p/{id} can probe
  // relative /health successfully.
  const healthMatch = pathname === '/health' || /^\/p\/[^/]+\/health$/.test(pathname);
  if (healthMatch && method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
    return true;
  }

  // Manifest endpoint (unauthenticated)
  if (pathname === '/.well-known/gateway.json' && method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify(state.manifest));
    return true;
  }

  // Pairing/access endpoint (unauthenticated). The tight limit is the
  // point: this route is reachable by anyone who can hit the port, and a
  // signed access request is a few hundred bytes.
  if (pathname === '/.well-known/gateway/access' && method === 'POST') {
    const body = await readJsonBody(req, { maxBytes: ACCESS_MAX_BODY_BYTES });
    const device = body?.device;
    if (!body || !device?.id || !device?.publicKey || !body.signature || typeof body.signedAtMs !== 'number') {
      res.writeHead(400);
      res.end(JSON.stringify({ status: 'denied', reason: 'Malformed access request.' }));
      return true;
    }

    const verification = verifySignedAccessRequest(
      {
        deviceId: device.id,
        publicKeyB64Url: device.publicKey,
        clientId: device.clientId,
        role: body.role ?? 'operator',
        scopes: Array.isArray(body.scopes) ? body.scopes : [],
        signedAtMs: body.signedAtMs,
        signature: body.signature,
      },
      { replayCache },
    );

    if (!verification.ok) {
      // The same signed body retried after a lost answer is a replay, and
      // a body that crossed a plain-HTTP pairing leg (or a log, or a
      // proxy) is not a secret: answering it with the device token would
      // hand that token to whoever captured the body. The pending answer
      // carries no secret and stays idempotent; a grant does, so the
      // replay is told to sign again — the device holds the key and can.
      if (verification.replay) {
        const existing = await deviceTokens.list();
        const already = existing.find((entry) => entry.deviceId === device.id && !entry.revoked);
        if (already) {
          res.writeHead(409);
          res.end(JSON.stringify({
            status: 'signature-used',
            reason: 'This signed request was already answered. Sign a fresh request.',
          }));
          return true;
        }
        const pending = (await pairing.listPending()).find((entry) => entry.deviceId === device.id);
        if (pending) {
          res.writeHead(202);
          res.end(JSON.stringify({ status: 'pending', requestId: pending.requestId }));
          return true;
        }
      }
      res.writeHead(403);
      res.end(JSON.stringify({ status: 'denied', reason: verification.reason }));
      return true;
    }

    const existing = await deviceTokens.list();
    const already = existing.find((entry) => entry.deviceId === device.id && !entry.revoked);
    if (already) {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'granted', token: already.token, role: already.role, scopes: already.scopes }));
      return true;
    }

    const role = body.role ?? 'operator';
    const scopes = Array.isArray(body.scopes) ? body.scopes : [];

    if (await pairing.isWindowOpen()) {
      const grantedToken = await deviceTokens.issue(device.id, { role, scopes });
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'granted', token: grantedToken, role, scopes }));
      return true;
    }

    const requestId = await pairing.addPending({
      deviceId: device.id,
      publicKeyB64Url: device.publicKey,
      clientId: device.clientId,
      role,
      scopes,
    });
    res.writeHead(202);
    res.end(JSON.stringify({ status: 'pending', requestId }));
    return true;
  }

  return false;
}

import { createServer } from 'node:http';

export async function fakeOAuthIssuer(controls = {}) {
  const state = {
    refreshCalls: 0,
    revoked: [],
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    nextAccess: 'access-2',
    nextRefresh: 'refresh-2',
    rotate: true,
    failRefresh: null,
    deviceStatus: 'authorization_pending',
    ...controls,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, {
        issuer: origin(server),
        authorization_endpoint: `${origin(server)}/authorize`,
        token_endpoint: `${origin(server)}/token`,
        revocation_endpoint: `${origin(server)}/revoke`,
        device_authorization_endpoint: `${origin(server)}/device`,
        code_challenge_methods_supported: ['S256'],
      });
    }

    if (url.pathname === '/token') {
      if (body.grant_type === 'refresh_token') {
        state.refreshCalls += 1;
        if (state.failRefresh) {
          res.writeHead(state.failRefresh.status ?? 400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: state.failRefresh.error ?? 'invalid_grant' }));
          return;
        }
        if (state.rotate) {
          state.accessToken = state.nextAccess;
          state.refreshToken = state.nextRefresh;
        }
        return json(res, {
          access_token: state.accessToken,
          refresh_token: state.refreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (state.deviceStatus !== 'authorized') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: state.deviceStatus }));
          return;
        }
        return json(res, {
          access_token: state.accessToken,
          refresh_token: state.refreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return json(res, {
        access_token: state.accessToken,
        refresh_token: state.refreshToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }

    if (url.pathname === '/device') {
      return json(res, {
        device_code: 'device-1',
        user_code: 'WDJB-MJHT',
        verification_uri: `${origin(server)}/device`,
        interval: 1,
        expires_in: 600,
      });
    }

    if (url.pathname === '/revoke') {
      state.revoked.push(body.token);
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    get issuer() { return origin(server); },
    get refreshCalls() { return state.refreshCalls; },
    get revoked() { return state.revoked; },
    authorizeDevice() { state.deviceStatus = 'authorized'; },
    failRefreshWith(error, status = 400) { state.failRefresh = { error, status }; },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

function origin(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
  });
}

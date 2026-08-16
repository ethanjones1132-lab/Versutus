import { createServer } from 'node:http';

export function startProviderStub(options = {}) {
  const {
    spec = 'versutus-provider/v1',
    id = 'echo',
    label = 'Echo',
    authSchemes = ['bearer'],
    credentialCustodian = 'external',
    models = [{ id: 'echo-1', available: true }],
    health = { status: 'ok' },
    redirectWellKnown,
    chatText = 'pong',
    oversizedBody = false,
    incompatibleOnDiscover = false,
  } = options;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/.well-known/versutus-provider.json') {
      if (redirectWellKnown) {
        res.writeHead(302, { location: redirectWellKnown });
        res.end();
        return;
      }
      if (incompatibleOnDiscover) {
        json(res, { spec: 'versutus-provider/v0', id, label });
        return;
      }
      json(res, {
        spec,
        id,
        label,
        protocols: ['openai_chat'],
        auth: { schemes: authSchemes, credentialCustodian },
        endpoints: {
          health: '/v1/health',
          models: '/v1/models',
          chat: '/v1/chat/completions',
        },
      });
      return;
    }

    if (url.pathname === '/v1/health') {
      json(res, health);
      return;
    }

    if (url.pathname === '/v1/models') {
      if (oversizedBody) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"data":"${'x'.repeat(2 * 1024 * 1024)}"}`);
        return;
      }
      json(res, { data: models });
      return;
    }

    if (url.pathname === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (url.searchParams.get('stream') === '1' || req.headers.accept === 'text/event-stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chatText } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        json(res, {
          choices: [{ message: { role: 'assistant', content: chatText } }],
        });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        origin: `http://127.0.0.1:${port}`,
        manifestUrl: `http://127.0.0.1:${port}/.well-known/versutus-provider.json`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

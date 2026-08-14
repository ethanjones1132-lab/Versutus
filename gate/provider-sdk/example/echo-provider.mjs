import { createServer } from 'node:http';

export function startEchoProvider({ port = 0 } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/.well-known/versutus-provider.json') {
      return send(res, {
        spec: 'versutus-provider/v1',
        id: 'echo',
        label: 'Echo',
        protocols: ['openai_chat'],
        auth: { schemes: ['bearer'], credentialCustodian: 'external' },
        endpoints: {
          health: '/v1/health',
          models: '/v1/models',
          chat: '/v1/chat/completions',
        },
      });
    }
    if (url.pathname === '/v1/health') {
      return send(res, { status: 'ok' });
    }
    if (url.pathname === '/v1/models') {
      return send(res, { data: [{ id: 'echo-1', available: true }] });
    }
    if (url.pathname === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
        const last = Array.isArray(body.messages) ? body.messages.at(-1)?.content ?? '' : '';
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: last || 'pong' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        send(res, {
          choices: [{ message: { role: 'assistant', content: last || 'pong' } }],
        });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function send(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('echo-provider.mjs');
if (invokedDirectly) {
  const started = await startEchoProvider({ port: Number(process.env.PORT ?? 0) });
  console.log(`echo provider listening on ${started.origin}`);
}

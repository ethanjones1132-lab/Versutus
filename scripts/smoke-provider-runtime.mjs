import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { createGate } from '../gate/core/server.mjs';
import { ProviderStore } from '../gate/core/providers/store.mjs';
import { CredentialVault } from '../gate/core/credentials/vault.mjs';

const root = await mkdtemp(join(tmpdir(), 'smoke-provider-'));
const gateHome = join(root, 'home');
const upstream = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'smoke-model' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const { port } = upstream.address();

try {
  const store = new ProviderStore(gateHome);
  const vault = new CredentialVault({
    gateHome,
    backend: {
      protect: async (plain) => Buffer.from(plain),
      unprotect: async (cipher) => Buffer.from(cipher),
    },
  });
  await vault.set('provider/smoke/api-key', 'fixture');
  await store.put({
    schemaVersion: 2,
    kind: 'provider',
    id: 'smoke',
    label: 'Smoke API',
    providerType: 'openai',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      credentialRef: 'provider/smoke/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 5000 },
  }, { catalog: { source: 'legacy_bootstrap', state: 'stale', generation: 0, models: [] } });

  const gate = await createGate({ root, gateHome, port: 0, vault });
  const listed = await fetch(`http://127.0.0.1:${gate.port}/v1/providers`, {
    headers: { Authorization: `Bearer ${gate.token}` },
  });
  if (listed.status !== 200) throw new Error(`providers ${listed.status}`);
  const body = await listed.json();
  if (JSON.stringify(body).includes('fixture')) throw new Error('secret leaked');
  await gate.close();

  const again = await createGate({ root, gateHome, port: 0, vault });
  const persisted = await fetch(`http://127.0.0.1:${again.port}/v1/providers`, {
    headers: { Authorization: `Bearer ${again.token}` },
  });
  const persistedBody = await persisted.json();
  if (!persistedBody.providers.some((provider) => provider.id === 'smoke')) {
    throw new Error('provider did not survive restart');
  }
  await again.close();
  console.log('smoke-provider-runtime: PASS');
} finally {
  upstream.close();
  await rm(root, { recursive: true, force: true });
}

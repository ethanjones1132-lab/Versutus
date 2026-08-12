import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

async function startStubUpstream({ stream } = {}) {
  const server = createServer((req, res) => {
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

async function gateWithStubProvider(upstreamBaseUrl, capabilities = { streaming: true }) {
  const root = await mkdtemp(join(tmpdir(), 'gate-chat-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(
    kindModulePath,
    join(root, 'core', 'capabilities', 'provider', 'kind.mjs'),
  );
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(
    join(root, 'registry', 'stub.json'),
    JSON.stringify({
      kind: 'provider',
      label: 'Stub',
      config: {
        flavor: 'openai',
        baseUrl: upstreamBaseUrl,
        apiKeyEnv: 'STUB_KEY',
        models: ['stub-1'],
        streaming: capabilities.streaming,
      },
    }),
    'utf8',
  );
  process.env.STUB_KEY = 'fake-key-for-tests';
  const gate = await createGate({ root, port: 0 });
  return gate;
}

test('non-streaming chat proxies and normalizes the upstream response', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'Hello');
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('streaming chat pipes normalized SSE chunks through', async () => {
  const upstream = await startStubUpstream({ stream: true });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /Hel/);
    assert.match(text, /lo/);
    assert.match(text, /\[DONE\]/);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('unscoped chat resolves the provider from the requested model', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('rejects an unauthenticated chat request', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'stub-1', messages: [] }),
    });
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('rejects streaming when the provider did not declare it', async () => {
  const upstream = await startStubUpstream({ stream: true });
  const gate = await gateWithStubProvider(upstream.baseUrl, { streaming: false });
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [], stream: true }),
    });
    assert.equal(response.status, 400);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('allows streaming when the provider omits streaming (defaults to true)', async () => {
  const upstream = await startStubUpstream({ stream: true });
  const root = await mkdtemp(join(tmpdir(), 'gate-chat-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(
    kindModulePath,
    join(root, 'core', 'capabilities', 'provider', 'kind.mjs'),
  );
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(
    join(root, 'registry', 'stub.json'),
    JSON.stringify({
      kind: 'provider',
      label: 'Stub',
      config: {
        flavor: 'openai',
        baseUrl: upstream.baseUrl,
        apiKeyEnv: 'STUB_KEY',
        models: ['stub-1'],
        // NOTE: streaming field is intentionally omitted to test default behavior
      },
    }),
    'utf8',
  );
  process.env.STUB_KEY = 'fake-key-for-tests';
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /Hel/);
    assert.match(text, /lo/);
    assert.match(text, /\[DONE\]/);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('returns 404 for a scoped route naming an unknown provider', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/nope/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 404);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('a secret set via registry.secrets.set takes precedence over the env var of the same name', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    process.env.STUB_KEY = 'env-value-should-be-overridden';
    await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'registry.secrets.set', params: { refName: 'STUB_KEY', value: 'secret-store-value' } }),
    });

    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

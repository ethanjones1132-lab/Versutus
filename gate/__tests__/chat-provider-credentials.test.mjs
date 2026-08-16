import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

const CREDENTIAL = 'nvapi-test-credential';
const CREDENTIAL_REF = 'provider-nim-api-key';

/** Upstream that records what it was actually sent. */
async function startRecordingUpstream({ stream } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization ?? null, url: req.url });
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
  return { server, seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

/**
 * Reproduces the deployed shape: `migrate-v1` copied the registry provider into
 * the v2 store but left `registry/<id>.json` in place, so both claim id `nim`.
 * The v2 record owns the credential; the legacy record names an env var that is
 * not set and declares only its own stale model list.
 */
async function gateWithMigratedProvider(upstreamBaseUrl) {
  const root = await mkdtemp(join(tmpdir(), 'gate-cred-'));
  const gateHome = join(root, '.gate-home');

  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));

  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(join(root, 'registry', 'nim.json'), JSON.stringify({
    kind: 'provider',
    label: 'NIM (legacy registry copy)',
    config: {
      flavor: 'openai',
      baseUrl: upstreamBaseUrl,
      apiKeyEnv: 'NIM_KEY_THAT_IS_NOT_SET',
      models: ['stale-bootstrap-model'],
      streaming: true,
    },
  }), 'utf8');

  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'providers', 'nim.json'), JSON.stringify({
    schemaVersion: 2,
    kind: 'provider',
    id: 'nim',
    label: 'NIM',
    providerType: 'nvidia-nim',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: upstreamBaseUrl,
      credentialRef: CREDENTIAL_REF,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  }), 'utf8');

  await mkdir(join(gateHome, 'state', 'providers'), { recursive: true });
  await writeFile(join(gateHome, 'state', 'providers', 'nim.json'), JSON.stringify({
    catalog: {
      source: 'live',
      state: 'fresh',
      generation: 1,
      models: [{ providerId: 'nim', id: 'live-catalog-model', label: 'live-catalog-model', available: true }],
    },
  }), 'utf8');

  // Migration receipt: the real Gate has already migrated, so it will not re-run.
  await mkdir(join(gateHome, 'state', 'migrations'), { recursive: true });
  await writeFile(
    join(gateHome, 'state', 'migrations', 'provider-v2.json'),
    JSON.stringify({ id: 'provider-v2', migratedAt: new Date().toISOString(), providers: ['nim'] }),
    'utf8',
  );

  await new CredentialVault({ gateHome }).set(CREDENTIAL_REF, CREDENTIAL);

  const gate = await createGate({ root, port: 0, gateHome });
  return { gate, root };
}

async function postChat(gate, body) {
  return fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify(body),
  });
}

test('unscoped chat sends the v2 provider credential upstream', async () => {
  const upstream = await startRecordingUpstream({ stream: false });
  const { gate } = await gateWithMigratedProvider(upstream.baseUrl);
  try {
    const response = await postChat(gate, {
      model: 'live-catalog-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200, `expected 200, body: ${await response.clone().text()}`);
    assert.equal(upstream.seen.length, 1, 'upstream should have been called exactly once');
    assert.equal(upstream.seen[0].authorization, `Bearer ${CREDENTIAL}`);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('streaming chat sends the credential and pipes normalized SSE', async () => {
  const upstream = await startRecordingUpstream({ stream: true });
  const { gate } = await gateWithMigratedProvider(upstream.baseUrl);
  try {
    const response = await postChat(gate, {
      model: 'live-catalog-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(response.status, 200, `expected 200, body: ${await response.clone().text()}`);
    const text = await response.text();
    assert.match(text, /Hel/);
    assert.match(text, /lo/);
    assert.match(text, /\[DONE\]/);
    assert.equal(upstream.seen[0].authorization, `Bearer ${CREDENTIAL}`);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('a model from the live catalog is not gated by the stale registry model list', async () => {
  const upstream = await startRecordingUpstream({ stream: false });
  const { gate } = await gateWithMigratedProvider(upstream.baseUrl);
  try {
    const response = await postChat(gate, {
      model: 'live-catalog-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = await response.json();
    assert.notEqual(body?.error?.code, 'invalid_model');
    assert.equal(response.status, 200);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('scoped chat also reaches the v2 provider rather than the registry copy', async () => {
  const upstream = await startRecordingUpstream({ stream: false });
  const { gate } = await gateWithMigratedProvider(upstream.baseUrl);
  try {
    const response = await postChat(gate, {
      providerId: 'nim',
      model: 'live-catalog-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200, `expected 200, body: ${await response.clone().text()}`);
    assert.equal(upstream.seen[0].authorization, `Bearer ${CREDENTIAL}`);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

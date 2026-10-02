import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

// The two round-4 fixes meet on one code path: a named provider turn is durable
// (R4D3) AND its vendor read is bounded by silence (g4, PROV-3 / V-4). Neither
// alone is enough. Idle-bounding without durability records the failure and
// drops it when the phone is gone; durability without idle-bounding waits on a
// silent vendor forever. These drive a real Gate over HTTP so the claim holds
// across the phone leaving and the relay reading on.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all([...new Set(roots.splice(0))].map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

const TURN_ID = 'turn-prov-idle-01';
const SESSION_ID = 'ses_prov_idle_1';

const sseDelta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

/**
 * A vendor that streams one delta and then goes silent forever. Its headers
 * clear the header watchdog, so only the relay's idle deadline can end the turn.
 */
async function startSilentVendor() {
  const sockets = new Set();
  const server = createServer((_req, res) => {
    sockets.add(res.socket);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseDelta('Hel'));
    // Deliberately no further writes and no res.end(): the vendor stopped.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A vendor that streams steadily but slowly: each chunk arrives well inside the
 * idle bound, while the total runtime exceeds it several times over. It must
 * never be cut off for being slow, only for falling silent.
 */
async function startSlowVendor({ intervalMs, chunks }) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let index = 0;
    const timer = setInterval(() => {
      if (index >= chunks.length || res.writableEnded) {
        clearInterval(timer);
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }
      res.write(sseDelta(chunks[index]));
      index += 1;
    }, intervalMs);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A v2 Gate holding one `openai-compatible` provider whose own request timeout
 * is the relay's idle bound. The v2 ProviderService path is the one that reads
 * `requestPolicy.timeoutMs` into `relayNormalizedSse` and records outcomes.
 */
async function makeIdleGate(upstreamBaseUrl, { timeoutMs }) {
  const root = await mkdtemp(join(tmpdir(), 'gate-durable-idle-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  const store = new ProviderStore(gateHome);
  await store.put({
    schemaVersion: 2,
    kind: 'provider',
    id: 'stub',
    label: 'Stub',
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: upstreamBaseUrl,
      credentialRef: 'provider/stub/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs },
  }, {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
  });
  const vault = new CredentialVault({
    gateHome,
    backend: {
      protect: async (buffer) => buffer,
      unprotect: async (buffer) => buffer,
    },
  });
  await vault.set('provider/stub/api-key', 'fake-key-for-tests');
  const gate = await createGate({
    root,
    gateHome,
    vault,
    port: 0,
    voiceWarmStart: false,
    detachedTurnMaxMs: 30_000,
    detachedStallMs: 30_000,
  });
  let closed = false;
  return {
    gate,
    base: `http://127.0.0.1:${gate.port}`,
    close: () => (closed ? Promise.resolve() : (closed = true, gate.close())),
  };
}

const auth = (gate) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${gate.token}`,
});

const streamingTurn = (harness, { turnId, controller } = {}) => fetch(
  `${harness.base}/v1/chat/completions`,
  {
    method: 'POST',
    headers: {
      ...auth(harness.gate),
      ...(turnId ? { 'X-Versutus-Turn-Id': turnId } : {}),
    },
    signal: controller?.signal,
    body: JSON.stringify({
      providerId: 'stub',
      model: 'stub-1',
      sessionId: SESSION_ID,
      messages: [{ role: 'user', content: 'say it once' }],
      stream: true,
    }),
  },
);

const turnMeta = async (harness, turnId) => {
  const response = await fetch(`${harness.base}/v1/turns/${turnId}`, {
    headers: { Authorization: `Bearer ${harness.gate.token}` },
  });
  return { status: response.status, body: await response.json() };
};

const until = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
};

test('a durable turn whose vendor goes silent after the first chunk ends failed, and its replay carries the error frame', { timeout: 15_000 }, async () => {
  const vendor = await startSilentVendor();
  const harness = await makeIdleGate(vendor.baseUrl, { timeoutMs: 300 });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(harness, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    // The phone leaves after the turn is running; the vendor has already sent
    // its one chunk and gone silent, so only the idle bound can close it.
    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).status === 200),
      'the turn must be on the journal before the phone leaves',
    );
    controller.abort();
    await pending.catch(() => undefined);

    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).body.status === 'failed'),
      'a silent vendor must be recorded as failed, not left open',
    );
    const { status, body } = await turnMeta(harness, TURN_ID);
    assert.equal(status, 200);
    assert.equal(body.status, 'failed');

    // The failure is not just a verdict: the error frame was journalled, so a
    // retry replays it instead of reading as a clean finish.
    const retry = await streamingTurn(harness, { turnId: TURN_ID });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-versutus-turn-resumed'), '1');
    const replayed = await retry.text();
    assert.match(replayed, /"error"/, 'the replay carries the journalled error frame');
    assert.match(replayed, /upstream_idle/, 'the failure is named as the silence it was');
    // The one chunk the vendor did send is still there; the failure is named
    // instead of the turn reading as a clean [DONE] finish.
    assert.match(replayed, /Hel/);
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('a durable turn whose vendor streams slowly but steadily is not cut off by the idle bound', { timeout: 15_000 }, async () => {
  // Each chunk arrives at 100ms; the idle bound is 300ms, so the gaps are all
  // inside it while the total (1000ms) exceeds it more than three times. A
  // bound that measured total length would cut this off; a silence bound must
  // let the whole reply through.
  const chunks = ['the ', 'whole ', 'answer ', 'in ', 'many ', 'slow ', 'pieces ', 'arrives ', 'whole ', 'intact'];
  const vendor = await startSlowVendor({ intervalMs: 100, chunks });
  const harness = await makeIdleGate(vendor.baseUrl, { timeoutMs: 300 });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(harness, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).status === 200),
      'the turn must be on the journal before the phone leaves',
    );
    controller.abort();
    await pending.catch(() => undefined);

    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).body.status === 'done', 10_000),
      'a slow but steady vendor must run to its own end',
    );
    const { body } = await turnMeta(harness, TURN_ID);
    assert.equal(body.status, 'done');
    assert.equal(body.text, chunks.join(''));
  } finally {
    await harness.close();
    await vendor.close();
  }
});

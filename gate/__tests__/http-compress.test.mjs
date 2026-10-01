import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { request as httpRequest, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { createGate } from '../core/server.mjs';
import { enableJsonCompression } from '../core/http-compress.mjs';
import { ProviderStore } from '../core/providers/store.mjs';

// The phone reaches the Gate over Tailscale, often through a DERP relay on
// cellular, and React Native's fetch (OkHttp) already sends `Accept-Encoding:
// gzip` and inflates the answer itself. The Gate answered every read
// uncompressed — the model catalogue alone is ~241 KB — so these tests pin what
// the wrapper may compress (one-shot answers big enough to pay for it) and,
// just as importantly, what it must leave byte-for-byte alone (streams, small
// answers, HEAD, refusals).

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

/** A request carrying only what the wrapper is allowed to look at. */
function fakeRequest({ acceptEncoding = 'gzip', method = 'GET' } = {}) {
  return { method, headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} };
}

/**
 * The smallest response a route can drive: no socket, no transport, and the two
 * flags routes read (`headersSent`, `writableEnded`).
 */
function fakeResponse() {
  const headers = new Map();
  const chunks = [];
  const state = { sent: false, ended: false };
  const res = {
    statusCode: 200,
    destroyed: false,
    get headersSent() { return state.sent; },
    get writableEnded() { return state.ended; },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); return res; },
    removeHeader(name) { headers.delete(String(name).toLowerCase()); },
    writeHead(statusCode, ...rest) {
      res.statusCode = statusCode;
      const extra = rest.at(-1);
      if (Array.isArray(extra)) for (const [name, value] of extra) res.setHeader(name, value);
      else if (extra) for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
      state.sent = true;
      return res;
    },
    write(chunk) {
      state.sent = true;
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk, callback) {
      if (typeof chunk === 'function') { callback = chunk; chunk = null; }
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
      state.sent = true;
      state.ended = true;
      if (callback) callback();
      return res;
    },
    get body() { return Buffer.concat(chunks); },
    get headerMap() { return headers; },
  };
  return res;
}

const BIG_JSON = JSON.stringify({ object: 'list', data: Array.from({ length: 40 }, (_, index) => ({
  id: `vendor/model-${String(index).padStart(3, '0')}`,
  provider: 'live',
  providerId: 'live',
  label: `vendor/model-${String(index).padStart(3, '0')}`,
  object: 'model',
  catalogSource: 'live',
})) });

test('a one-shot answer above the threshold is gzipped and inflates to the same JSON', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(BIG_JSON);

  assert.equal(res.getHeader('Content-Encoding'), 'gzip');
  assert.equal(res.getHeader('Vary'), 'Accept-Encoding');
  assert.equal(res.getHeader('Content-Type'), 'application/json');
  assert.equal(res.statusCode, 200);
  assert.equal(Number(res.getHeader('Content-Length')), res.body.length);
  assert.deepEqual(JSON.parse(gunzipSync(res.body).toString()), JSON.parse(BIG_JSON));
});

test('a stale Content-Length the route set is replaced by the compressed one', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.setHeader('Content-Length', String(Buffer.byteLength(BIG_JSON)));
  res.writeHead(200);
  res.end(BIG_JSON);

  assert.equal(Number(res.getHeader('Content-Length')), res.body.length);
  assert.ok(res.body.length < Buffer.byteLength(BIG_JSON));
});

test('a stale Content-Length passed to writeHead itself does not survive', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' });
  res.end(BIG_JSON);

  assert.equal(Number(res.getHeader('Content-Length')), res.body.length);
  assert.equal(JSON.parse(gunzipSync(res.body).toString()).data.length, 40);
});

test('an existing Vary (CORS) is extended, never replaced', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.setHeader('Vary', 'Origin');
  res.writeHead(200);
  res.end(BIG_JSON);

  assert.equal(res.getHeader('Vary'), 'Origin, Accept-Encoding');
});

test('an answer below the threshold is left exactly as it was', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(200);
  const small = JSON.stringify({ status: 'ok', timestamp: '2026-10-01T00:00:00.000Z' });
  res.end(small);

  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.getHeader('Vary'), undefined);
  assert.equal(res.body.toString(), small);
});

test('without Accept-Encoding nothing is compressed', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest({ acceptEncoding: null }), res);
  res.writeHead(200);
  res.end(BIG_JSON);

  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.body.toString(), BIG_JSON);
});

test('gzip;q=0 is a refusal, not an invitation', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest({ acceptEncoding: 'gzip;q=0, deflate' }), res);
  res.writeHead(200);
  res.end(BIG_JSON);

  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.body.toString(), BIG_JSON);
});

test('HEAD is never compressed', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest({ method: 'HEAD' }), res);
  res.writeHead(200);
  res.end(BIG_JSON);

  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.body.toString(), BIG_JSON);
});

test('an error response keeps its status and every other header', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(502, { 'Content-Type': 'application/json', 'X-Versutus-Session-Id': 'ses_1' });
  const error = JSON.stringify({ error: { message: 'x'.repeat(2000), code: 'backend_error' } });
  res.end(error);

  assert.equal(res.statusCode, 502);
  assert.equal(res.getHeader('X-Versutus-Session-Id'), 'ses_1');
  assert.equal(JSON.parse(gunzipSync(res.body).toString()).error.code, 'backend_error');
});

test('headersSent is true right after writeHead, as a route expects', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(200);
  assert.equal(res.headersSent, true);
  assert.equal(res.writableEnded, false);
  res.end(BIG_JSON);
  assert.equal(res.writableEnded, true);
  assert.equal(res.headersSent, true);
});

test('a route may still setHeader after writeHead', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(200);
  res.setHeader('X-Versutus-Turn-Id', 'turn_1');
  res.end(BIG_JSON);

  assert.equal(res.getHeader('X-Versutus-Turn-Id'), 'turn_1');
  assert.equal(res.getHeader('Content-Encoding'), 'gzip');
});

test('a failing compression falls back to the original body', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res, { gzip: () => { throw new Error('zlib said no'); } });
  res.writeHead(200);
  res.end(BIG_JSON);

  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.getHeader('Vary'), undefined);
  assert.equal(res.body.toString(), BIG_JSON);
});

test('an event stream is passed through frame by frame', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Versutus-Keepalive-Ms': '15000' });
  res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
  res.write('data: [DONE]\n\n');
  res.end();

  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.getHeader('X-Versutus-Keepalive-Ms'), '15000');
  assert.equal(res.body.toString(), 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
    + 'data: [DONE]\n\n');
});

test('the first write passes the response through, whatever the status', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write(BIG_JSON);
  res.end();

  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.body.toString(), BIG_JSON);
});

test('a response that already carries Content-Encoding is left alone', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' });
  res.end(BIG_JSON);

  assert.equal(res.getHeader('Content-Encoding'), 'br');
  assert.equal(res.body.toString(), BIG_JSON);
});

test('a 204 is sent unchanged', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(204);
  res.end('x'.repeat(4096));

  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.body.toString(), 'x'.repeat(4096));
});

test('an answer finished without a writeHead of its own is still gzipped', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.end(BIG_JSON);

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('Content-Encoding'), 'gzip');
  assert.equal(res.getHeader('Content-Length'), String(res.body.length));
  assert.equal(JSON.parse(gunzipSync(res.body).toString()).data.length, 40);
});

test('an empty end with no writeHead leaves the response untouched', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.end();

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('Content-Encoding'), undefined);
  assert.equal(res.body.length, 0);
});

test('the end callback still runs on the compressed answer', () => {
  const res = fakeResponse();
  enableJsonCompression(fakeRequest(), res);
  res.writeHead(200);
  let flushed = false;
  res.end(BIG_JSON, () => { flushed = true; });

  assert.equal(flushed, true);
  assert.equal(res.getHeader('Content-Encoding'), 'gzip');
});

// --- The real Gate, over a real socket -------------------------------------

function auth(gate) {
  return { Authorization: `Bearer ${gate.token}` };
}

/** A raw request: `fetch` inflates a gzip body and hides what went on the wire. */
function rawRequest(port, requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      const arrival = [];
      res.on('data', (chunk) => { chunks.push(chunk); arrival.push(Date.now()); });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        chunks: arrival,
        firstChunk: chunks[0],
      }));
    });
    request.on('error', reject);
    if (body) request.end(body);
    else request.end();
  });
}

async function gateWithBigCatalog() {
  const root = await mkdtemp(join(tmpdir(), 'gate-compress-'));
  const gateHome = join(root, '.gate-home');
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));

  const store = new ProviderStore(gateHome);
  const modelIds = Array.from({ length: 40 }, (_, index) => `vendor/model-${String(index).padStart(3, '0')}`);
  await store.put({
    schemaVersion: 2,
    kind: 'provider',
    id: 'live',
    label: 'live',
    providerType: 'openai-compatible',
    enabled: true,
    registration: { mode: 'api_key', protocol: 'openai_chat', baseUrl: 'http://127.0.0.1:1/v1', credentialRef: 'provider/live/api-key' },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 5000 },
  }, {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
    catalog: {
      source: 'live',
      state: 'fresh',
      generation: 1,
      observedAt: '2026-01-01T00:00:00.000Z',
      models: modelIds.map((id) => ({ id, label: id, providerId: 'live', available: true })),
    },
  });

  const gate = await createGate({ root, gateHome, port: 0 });
  return { gate, root, modelIds };
}

test('GET /v1/models is gzipped for a client that accepts it, and inflates to the same JSON', { timeout: 60000 }, async () => {
  const { gate, root } = await gateWithBigCatalog();
  try {
    const plain = await rawRequest(gate.port, '/v1/models', { headers: auth(gate) });
    assert.equal(plain.status, 200);
    assert.ok(plain.body.length > 1024, 'the catalogue must be big enough to be worth compressing');
    assert.equal(plain.headers['content-encoding'], undefined);

    const zipped = await rawRequest(gate.port, '/v1/models', {
      headers: { ...auth(gate), 'Accept-Encoding': 'gzip' },
    });
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.equal(zipped.headers['content-type'], 'application/json');
    assert.equal(zipped.headers['vary'], 'Accept-Encoding');
    assert.equal(Number(zipped.headers['content-length']), zipped.body.length);
    assert.ok(zipped.body.length < plain.body.length / 2, 'the catalogue must actually get smaller');
    assert.deepEqual(
      JSON.parse(gunzipSync(zipped.body).toString()),
      JSON.parse(plain.body.toString()),
    );
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('gzip;q=0 leaves GET /v1/models uncompressed', { timeout: 60000 }, async () => {
  const { gate, root } = await gateWithBigCatalog();
  try {
    const response = await rawRequest(gate.port, '/v1/models', {
      headers: { ...auth(gate), 'Accept-Encoding': 'gzip;q=0' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(response.body.toString()).data.length, 40);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a small JSON answer is not compressed even when gzip is accepted', { timeout: 60000 }, async () => {
  const { gate, root } = await gateWithBigCatalog();
  try {
    const response = await rawRequest(gate.port, '/health', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(response.body.toString()).status, 'ok');
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a 401 refusal is unchanged by the wrapper', { timeout: 60000 }, async () => {
  const { gate, root } = await gateWithBigCatalog();
  try {
    const response = await rawRequest(gate.port, '/v1/models', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(response.body.toString()).error, 'Unauthorized');
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a route that never calls writeHead still answers with a status line and a gzip body', { timeout: 60000 }, async () => {
  const rows = JSON.stringify({ object: 'list', data: Array.from({ length: 40 }, (_, index) => ({ id: `model-${index}`, label: 'x'.repeat(40) })) });
  const server = createServer((req, res) => {
    enableJsonCompression(req, res);
    res.setHeader('Content-Type', 'application/json');
    // No writeHead: node:http writes the status line itself from inside end().
    res.end(rows);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await rawRequest(server.address().port, '/', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(Number(response.headers['content-length']), response.body.length);
    assert.deepEqual(JSON.parse(gunzipSync(response.body).toString()), JSON.parse(rows));
  } finally {
    server.close();
  }
});

/**
 * An upstream that answers a streamed turn in two frames, a gap apart.
 *
 * `marks.secondFrameAt` is when the second frame was written, so the test can ask
 * a causal question — did the first frame reach the phone before the backend had
 * even produced the next one? — instead of a wall-clock one that a loaded machine
 * could turn flaky.
 */
async function startStreamingUpstream({ gapMs = 150 } = {}) {
  const marks = { secondFrameAt: null };
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
    setTimeout(() => {
      marks.secondFrameAt = Date.now();
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, gapMs).unref();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, marks, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function gateWithStreamingProvider(baseUrl) {
  const root = await mkdtemp(join(tmpdir(), 'gate-compress-chat-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(join(root, 'registry', 'stub.json'), JSON.stringify({
    kind: 'provider',
    label: 'Stub',
    config: { flavor: 'openai', baseUrl, apiKeyEnv: 'STUB_KEY', models: ['stub-1'], streaming: true },
  }), 'utf8');
  process.env.STUB_KEY = 'fake-key-for-tests';
  const gate = await createGate({ root, port: 0 });
  return { gate, root };
}

test('a streaming chat turn is relayed uncompressed and frame by frame', { timeout: 60000 }, async () => {
  const upstream = await startStreamingUpstream();
  const { gate, root } = await gateWithStreamingProvider(upstream.baseUrl);
  try {
    const body = JSON.stringify({
      model: 'stub-1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const response = await rawRequest(gate.port, '/p/stub/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gate.token}`,
        'Accept-Encoding': 'gzip',
      },
      body,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream');
    assert.equal(response.headers['content-encoding'], undefined, 'an SSE frame must reach the phone as it was written');
    assert.match(response.body.toString(), /Hel/);
    assert.match(response.body.toString(), /lo/);
    assert.match(response.body.toString(), /\[DONE\]/);
    assert.match(response.firstChunk.toString(), /Hel/, 'the first chunk must be the first frame, not the whole turn');
    assert.ok(upstream.marks.secondFrameAt !== null, 'the upstream must have written its second frame');
    assert.ok(
      response.chunks[0] < upstream.marks.secondFrameAt,
      'the first frame must reach the phone before the backend has written the second one, '
      + `so it cannot have been buffered until the turn ended (first chunk ${response.chunks[0]}, `
      + `second frame written ${upstream.marks.secondFrameAt})`,
    );
  } finally {
    await gate.close();
    upstream.server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
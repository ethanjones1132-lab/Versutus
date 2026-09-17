import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

async function setup(t, chat) {
  const root = await mkdtemp(join(tmpdir(), 'gate-stream-failure-'));
  const gateHome = join(root, '.gate-home');
  t.after(() => rm(root, { recursive: true, force: true }));
  await new ProviderStore(gateHome).put({
    schemaVersion: 2, kind: 'provider', id: 'stub', label: 'Stub',
    providerType: 'openai-compatible', enabled: true,
    registration: {
      mode: 'api_key', protocol: 'openai_chat',
      baseUrl: 'https://example.invalid/v1', credentialRef: 'provider/stub/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  });
  t.mock.method(ProviderService.prototype, 'chat', chat);
  const gate = await createGate({ root, gateHome, port: 0 });
  t.after(() => gate.close());
  return (stream = true) => fetch(`http://127.0.0.1:${gate.port}/p/stub/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ model: 'stub-model', messages: [], stream }),
  });
}

async function frames(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  return (await response.text()).split('\n\n').filter(Boolean).map((frame) => {
    assert.ok(frame.startsWith('data: '));
    const data = frame.slice(6);
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

const delta = (text) => ({ choices: [{ delta: { content: text } }] });

for (const partial of [false, true]) {
  test(`an iterator rejection ${partial ? 'after partial content' : 'before content'} ends with an error, not success`, async (t) => {
    const post = await setup(t, async () => (async function* () {
      if (partial) yield 'Hello';
      throw Object.assign(new Error('Provider stream interrupted'), { code: 'provider_disconnected' });
    })());
    assert.deepEqual(await frames(await post()), [
      ...(partial ? [delta('Hello')] : []),
      { error: { message: 'Provider stream interrupted', code: 'provider_disconnected' } },
    ]);
  });
}

test('an iterator failure without a message still gives the phone an actionable error', async (t) => {
  const post = await setup(t, async () => (async function* () {
    yield 'Partial';
    throw new Error();
  })());
  assert.deepEqual(await frames(await post()), [
    delta('Partial'),
    { error: { message: 'Provider stream interrupted before completion', code: 'upstream_error' } },
  ]);
});

test('a clean iterator preserves string and parsed deltas and ends exactly once', async (t) => {
  const post = await setup(t, async () => (async function* () {
    yield 'Hel';
    yield delta('lo');
  })());
  assert.deepEqual(await frames(await post()), [delta('Hel'), delta('lo'), '[DONE]']);
});

for (const fails of [false, true]) {
  test(`a raw provider reader ${fails ? 'failure preserves partial content and reports an error' : 'completion emits exactly one done marker'}`, async (t) => {
    let reads = 0;
    let cancelled = 0;
    const post = await setup(t, async () => ({
      body: { getReader: () => ({
        read: async () => {
          if (reads++ === 0) return {
            done: false,
            value: new TextEncoder().encode(`data: ${JSON.stringify(delta('Hello'))}\n\n`),
          };
          if (fails) throw new Error('Provider read failed');
          if (reads === 2) return { done: false, value: new TextEncoder().encode('data: [DONE]\n\n') };
          return { done: true };
        },
        cancel: async () => { cancelled += 1; },
      }) },
    }));
    assert.deepEqual(await frames(await post()), [
      delta('Hello'),
      ...(fails ? [{ error: { message: 'Provider read failed', code: 'upstream_error' } }] : ['[DONE]']),
    ]);
    assert.equal(cancelled, 1);
  });
}

test('a non-streaming provider refusal preserves its HTTP status and error code', async (t) => {
  const post = await setup(t, async () => {
    throw Object.assign(new Error('Provider quota exhausted'), { status: 429, code: 'rate_limited' });
  });
  const response = await post(false);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: { message: 'Provider quota exhausted', code: 'rate_limited' },
  });
});

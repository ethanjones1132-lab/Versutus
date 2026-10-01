import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProviderAdapter } from '../core/providers/factory.mjs';
import { createProfileAdapter } from '../core/providers/profiles/registry.mjs';
import { classifyProviderError } from '../core/providers/errors.mjs';

// `requestPolicy.timeoutMs` was validated, stored by every writer, and read by
// nothing: the profile adapter's fetch had neither a signal nor a deadline, so
// a vendor that accepted the connection and said nothing held a Gate socket
// (and the provider's commit queue behind it) for minutes after the phone had
// already given up at 30s.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const BUDGET_MS = 60;

/**
 * Run `fn` with the budget timers it creates counted, so a test can prove they
 * were all cleared. Only this budget's own delay is counted, so timers the test
 * runner starts in the same window are left alone.
 */
async function trackBudgetTimers(fn) {
  const created = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (handler, delay, ...rest) => {
    const timer = realSetTimeout(handler, delay, ...rest);
    if (delay === BUDGET_MS) created.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    created.delete(timer);
    return realClearTimeout(timer);
  };
  try {
    const outcome = await Promise.resolve().then(fn).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: undefined, error }),
    );
    return { ...outcome, leaked: [...created] };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

/** A fetch that answers nothing, and that reacts to an abort the way fetch does. */
function neverAnswers() {
  return (url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    });
  });
}

function adapterWith(fetchImpl) {
  return createProfileAdapter({
    profileId: 'openai-compatible',
    providerId: 'zen',
    // Loopback, so the origin allowlist is not what this test is about.
    baseUrl: 'http://127.0.0.1:9/v1',
    credential: 'test-key',
    fetchImpl,
    timeoutMs: BUDGET_MS,
  });
}

test('a models fetch that never answers is rejected as a timed-out request', async () => {
  const started = Date.now();
  const { error, leaked } = await trackBudgetTimers(() => adapterWith(neverAnswers()).listModels());

  assert.ok(error, 'the request must not be left hanging');
  assert.equal(error.code, 'ETIMEDOUT');
  assert.equal(
    classifyProviderError(error),
    'transient_network',
    'a timeout is a transient network fault, not an unknown error',
  );
  assert.ok(Date.now() - started < 5000, 'the request outlived its own budget');
  assert.deepEqual(leaked, [], 'the budget timer was left running after the abort');
});

test('an answered request is unaffected and clears its budget timer', async () => {
  const { value, error, leaked } = await trackBudgetTimers(() => adapterWith(async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'live-model' }] }),
  })).listModels());

  assert.equal(error, null);
  assert.deepEqual(value.map((model) => model.id), ['live-model']);
  assert.deepEqual(leaked, []);
});

test("the registration's own requestPolicy.timeoutMs bounds the vendor call", async () => {
  // A real socket that accepts and never answers: the shape that used to hang.
  const sockets = [];
  const server = createServer(() => {});
  server.on('connection', (socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const gateHome = await mkdtemp(join(tmpdir(), 'gate-provider-timeout-'));
  roots.push(gateHome);
  const vault = { has: async () => true, get: async () => 'test-key' };
  const adapter = createProviderAdapter({
    schemaVersion: 2,
    kind: 'provider',
    id: 'zen',
    label: 'Zen',
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      credentialRef: 'provider/zen/api-key',
    },
    requestPolicy: { timeoutMs: BUDGET_MS },
  }, { vault });

  try {
    await assert.rejects(
      () => adapter.listModels(),
      (error) => {
        assert.equal(error.code, 'ETIMEDOUT');
        return true;
      },
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
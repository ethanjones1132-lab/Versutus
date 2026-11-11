import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProviderAdapter } from '../core/providers/factory.mjs';
import { OAuthManager } from '../core/providers/oauth/refresh.mjs';

const config = {
  schemaVersion: 2,
  kind: 'provider',
  id: 'chat-instance',
  label: 'OAuth chat',
  providerType: 'openai-compatible',
  enabled: true,
  registration: {
    mode: 'oauth',
    protocol: 'openai_chat',
    resourceBaseUrl: 'http://127.0.0.1:8080/v1',
    oauthProfileId: 'test-oauth',
  },
  catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
  requestPolicy: { timeoutMs: 120000 },
};

test('stopping chat aborts its lone expired OAuth refresh without changing the grant', async () => {
  const refreshToken = 'rt-keep';
  const key = 'oauth/chat-instance';
  let stored = JSON.stringify({
    accessToken: 'old-access',
    refreshToken,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const vault = {
    get: async (requested) => requested === key ? stored : undefined,
    set: async (requested, value) => { if (requested === key) stored = value; },
    delete: async (requested) => { if (requested === key) stored = undefined; },
  };
  let discoverySignal;
  let refreshSignal;
  const oauth = new OAuthManager({
    vault,
    profiles: new Map([['test-oauth', {
      issuer: 'http://127.0.0.1:8080',
      clientId: 'public-client',
    }]]),
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('.well-known')) {
        discoverySignal = init.signal;
        return {
          ok: true,
          json: async () => ({ token_endpoint: 'http://127.0.0.1:8080/token' }),
        };
      }
      refreshSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const adapter = createProviderAdapter(config, { vault, oauth });
  const controller = new AbortController();
  const reason = new Error('chat stopped');
  const pending = adapter.chat({ model: 'test-model', messages: [], stream: false }, controller.signal);
  pending.catch(() => {});

  const deadline = Date.now() + 1000;
  while (!refreshSignal && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(refreshSignal, 'the expired grant started a token refresh');
  controller.abort(reason);
  const outcome = await Promise.race([
    pending.then(() => ({ resolved: true }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 250)),
  ]);

  assert.deepEqual(outcome, { error: reason }, 'chat rejects promptly with the caller abort reason');
  assert.equal(discoverySignal.aborted, true, 'issuer discovery shares the refresh cancellation');
  assert.equal(refreshSignal.aborted, true, 'the lone shared refresh is cancelled when its only waiter stops');
  assert.equal(JSON.parse(stored).refreshToken, refreshToken, 'an abort does not delete or rewrite the refresh token');
});

test('one stopped chat does not cancel a refresh shared by another chat', async (t) => {
  const refreshToken = 'rt-shared';
  let stored = JSON.stringify({
    accessToken: 'old-access',
    refreshToken,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const vault = {
    get: async () => stored,
    set: async (_key, value) => { stored = value; },
    delete: async () => { stored = undefined; },
  };
  let refreshSignal;
  let finishRefresh;
  const oauth = new OAuthManager({
    vault,
    profiles: new Map([['test-oauth', {
      issuer: 'http://127.0.0.1:8080',
      clientId: 'public-client',
    }]]),
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('.well-known')) {
        return {
          ok: true,
          json: async () => ({ token_endpoint: 'http://127.0.0.1:8080/token' }),
        };
      }
      refreshSignal = init.signal;
      return new Promise((resolve) => { finishRefresh = resolve; });
    },
  });
  const seenAuthorization = [];
  t.mock.method(globalThis, 'fetch', async (_url, init = {}) => {
    seenAuthorization.push(init.headers?.Authorization);
    return { ok: true, json: async () => ({ choices: [] }) };
  });
  const adapter = createProviderAdapter(config, { vault, oauth });
  const controller = new AbortController();
  const first = adapter.chat({ model: 'test-model', messages: [], stream: false }, controller.signal);
  const second = adapter.chat({ model: 'test-model', messages: [], stream: false });
  first.catch(() => {});

  const deadline = Date.now() + 1000;
  while (!finishRefresh && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(finishRefresh, 'both chats joined the token refresh flight');
  controller.abort(new Error('first chat stopped'));
  await assert.rejects(first, /first chat stopped/);
  assert.equal(refreshSignal.aborted, false, 'the remaining waiter keeps the shared refresh alive');
  finishRefresh({
    ok: true,
    json: async () => ({ access_token: 'new-access', refresh_token: refreshToken, expires_in: 3600 }),
  });
  await second;

  assert.deepEqual(seenAuthorization, ['Bearer new-access']);
  assert.equal(JSON.parse(stored).refreshToken, refreshToken);
});

test('a chat that arrives just after the last waiter stopped starts a fresh refresh', async () => {
  let stored = JSON.stringify({
    accessToken: 'old-access',
    refreshToken: 'rt-one',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const vault = {
    get: async () => stored,
    set: async (_key, value) => { stored = value; },
    delete: async () => { stored = undefined; },
  };
  const refreshes = [];
  const oauth = new OAuthManager({
    vault,
    profiles: new Map([['test-oauth', { issuer: 'http://127.0.0.1:8080', clientId: 'public-client' }]]),
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('.well-known')) {
        return { ok: true, json: async () => ({ token_endpoint: 'http://127.0.0.1:8080/token' }) };
      }
      const call = { signal: init.signal };
      refreshes.push(call);
      return new Promise((resolve, reject) => {
        call.finish = resolve;
        // A real socket takes a moment to tear down after an abort.
        init.signal?.addEventListener('abort', () => setTimeout(() => reject(init.signal.reason), 50), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const first = oauth.getAccess('chat-instance', { oauthProfileId: 'test-oauth', signal: controller.signal });
  first.catch(() => {});
  const deadline = Date.now() + 1000;
  while (refreshes.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort(new Error('first stopped'));
  // The stopped caller has left, but the cancelled refresh is still tearing down.
  await assert.rejects(first, /first stopped/);
  const second = oauth.getAccess('chat-instance', { oauthProfileId: 'test-oauth' });
  while (refreshes.length < 2 && Date.now() < deadline + 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(refreshes.length, 2, 'the late caller started its own refresh');
  assert.equal(refreshes[1].signal.aborted, false);
  refreshes[1].finish({
    ok: true,
    json: async () => ({ access_token: 'new-access', refresh_token: 'rt-one', expires_in: 3600 }),
  });
  const tokens = await second;
  assert.equal(tokens.accessToken, 'new-access');
});

test('a chat deadline aborts a stalled token refresh and rejects with its timeout', async () => {
  const refreshToken = 'rt-keep';
  let stored = JSON.stringify({
    accessToken: 'old-access',
    refreshToken,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const vault = {
    get: async () => stored,
    set: async (_key, value) => { stored = value; },
    delete: async () => { stored = undefined; },
  };
  let refreshSignal;
  let refreshStarted = false;
  const oauth = new OAuthManager({
    vault,
    profiles: new Map([['test-oauth', {
      issuer: 'http://127.0.0.1:8080',
      clientId: 'public-client',
    }]]),
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('.well-known')) {
        return {
          ok: true,
          json: async () => ({ token_endpoint: 'http://127.0.0.1:8080/token' }),
        };
      }
      refreshSignal = init.signal;
      refreshStarted = true;
      // Never answer: the refresh is only allowed to end on the chat's signal.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const adapter = createProviderAdapter(config, { vault, oauth });
  const controller = new AbortController();
  const pending = adapter.chat({ model: 'test-model', messages: [], stream: false }, controller.signal);
  pending.catch(() => {});

  const deadline = Date.now() + 1000;
  while (!refreshStarted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(refreshStarted, 'the expired grant started a token refresh');
  // Stands in for the upstream header watchdog: the chat's deadline aborts its
  // signal with a timeout, and that signal reaches the refresh now.
  controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  const outcome = await pending.then(() => ({ resolved: true }), (error) => ({ error }));

  assert.equal(outcome.error?.name, 'TimeoutError', 'chat rejects with the deadline error');
  assert.match(outcome.error.message, /timeout/i);
  assert.equal(refreshSignal.aborted, true, 'the stalled refresh fetch was aborted with the chat');
  assert.equal(JSON.parse(stored).refreshToken, refreshToken, 'a deadline does not delete or rewrite the grant');
});

test('a stop that lands after the token endpoint answered still stores the rotated grant', async () => {
  let stored = JSON.stringify({
    accessToken: 'old-access',
    refreshToken: 'rt-old',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const vault = {
    get: async () => stored,
    set: async (_key, value) => { stored = value; },
    delete: async () => { stored = undefined; },
  };
  let releaseBody;
  let bodyRequested = false;
  const oauth = new OAuthManager({
    vault,
    profiles: new Map([['test-oauth', { issuer: 'http://127.0.0.1:8080', clientId: 'public-client' }]]),
    fetchImpl: async (url) => {
      if (String(url).includes('.well-known')) {
        return { ok: true, json: async () => ({ token_endpoint: 'http://127.0.0.1:8080/token' }) };
      }
      // The provider has answered and rotated the grant; only the body read is still in flight.
      return {
        ok: true,
        json: () => {
          bodyRequested = true;
          return new Promise((resolve) => {
            releaseBody = () => resolve({ access_token: 'new-access', refresh_token: 'rt-rotated', expires_in: 3600 });
          });
        },
      };
    },
  });
  const controller = new AbortController();
  const pending = oauth.getAccess('chat-instance', { oauthProfileId: 'test-oauth', signal: controller.signal });
  pending.catch(() => {});
  const deadline = Date.now() + 1000;
  while (!bodyRequested && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(bodyRequested, 'the token endpoint answered');
  controller.abort(new Error('chat stopped'));
  await assert.rejects(pending, /chat stopped/);
  releaseBody();
  while (JSON.parse(stored).refreshToken !== 'rt-rotated' && Date.now() < deadline + 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(JSON.parse(stored).refreshToken, 'rt-rotated', 'the rotated refresh token is not lost to a late stop');
  assert.equal(JSON.parse(stored).accessToken, 'new-access');
});

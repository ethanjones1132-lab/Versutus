import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPushNotifier } from '../core/push-notifier.mjs';

function row(overrides = {}) {
  return {
    expoPushToken: 'ExponentPushToken[token-1]',
    platform: 'ios',
    timezone: 'UTC',
    enabled: true,
    richBody: false,
    botIds: [],
    quietHours: null,
    ...overrides,
  };
}

test('skips disabled devices', async () => {
  const tokens = {
    listEnabled: async () => [row({ enabled: false })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' });

  assert.deepEqual(sent, []);
});

test('skips devices inside their local quiet hours', async () => {
  const tokens = {
    listEnabled: async () => [row({ quietHours: { startMinutes: 0, endMinutes: 1439 } })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' });

  assert.deepEqual(sent, []);
});

test('skips devices whose bot allowlist does not include the event bot', async () => {
  const tokens = {
    listEnabled: async () => [row({ botIds: ['other-bot'] })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' });

  assert.deepEqual(sent, []);
});

test('deduplicates one final response per session transition', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });
  const event = { trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done', state: 'completed' };

  await notifier.notify(event);
  await notifier.notify(event);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.kind, 'reply');
  assert.equal(sent[0].data.sessionId, 'session-1');
});

test('classifies a cron final response as a routine', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({
    trigger: 'final-response',
    sessionId: 'cron_job1_20260911_090000',
    botId: 'scout',
    text: 'routine finished',
    state: 'completed',
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data, { kind: 'routine', jobId: 'job1', botId: 'scout' });
  assert.equal(sent[0].channelId, 'routine-results');
});

test('removes a row when Expo reports DeviceNotRegistered', async () => {
  const removed = [];
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async (token) => { removed.push(token); return true; },
  };
  const notifier = createPushNotifier({
    tokens,
    send: async () => ({ ok: true, deadTokens: ['ExponentPushToken[token-1]'] }),
  });

  const result = await notifier.notify({ trigger: 'run', runId: 'run-1' });

  assert.equal(result.ok, true);
  assert.deepEqual(removed, ['ExponentPushToken[token-1]']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPushNotifier, widgetSnapshot } from '../core/push-notifier.mjs';
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

test('a Bot filter never silences an approval card, which names no Bot', async () => {
  const tokens = {
    listEnabled: async () => [row({ botIds: ['other-bot'] })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  // The exact shape the environment supervisor emits (cli-environments/supervisor.mjs).
  await notifier.notify({ trigger: 'approval', runId: 'run-1', environmentId: 'codex-local', operation: 'prompt' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.kind, 'approval');
});

test('a Bot filter never silences a run verdict, which names no Bot', async () => {
  const tokens = {
    listEnabled: async () => [row({ botIds: ['other-bot'] })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'run', runId: 'run-2', state: 'completed', environmentId: 'codex-local' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.kind, 'run');
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

test('a device opted into widget updates gets a data-only companion message', async () => {
  const tokens = {
    listEnabled: async () => [row({ widgetUpdates: true, richBody: true })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'run', runId: 'run-1', state: 'completed', text: 'deployed the fix' });

  const widget = sent.find((message) => message.data?.kind === 'widget');
  assert.ok(widget, 'a widget companion must be sent');
  assert.equal(widget.title, undefined);
  assert.equal(widget.body, undefined);
  assert.equal(widget.data.widget.v, 2);
  assert.equal(widget.data.widget.result, 'deployed the fix');
  assert.equal(typeof widget.data.widget.writtenAt, 'number');
});

test('the widget companion reports the Gate snapshot instead of hard-coded idle', async () => {
  const tokens = {
    listEnabled: async () => [row({ widgetUpdates: true, richBody: true })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => { sent.push(...messages); return { ok: true }; },
    snapshot: () => ({ connected: true, work: '2 runs in flight', approvalsPending: 3 }),
  });

  await notifier.notify({ trigger: 'run', runId: 'run-1', state: 'completed', text: 'done' });

  const widget = sent.find((message) => message.data?.kind === 'widget');
  assert.ok(widget, 'a widget companion must be sent');
  assert.equal(widget.data.widget.status, 'Connected');
  assert.equal(widget.data.widget.connected, true);
  assert.equal(widget.data.widget.work, '2 runs in flight');
  assert.equal(widget.data.widget.approvalsPending, 3);
});

test('a disconnected Gate reads as disconnected on the widget', async () => {
  const tokens = {
    listEnabled: async () => [row({ widgetUpdates: true, richBody: true })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => { sent.push(...messages); return { ok: true }; },
    snapshot: { connected: false, work: 'No runs in flight', approvalsPending: 0 },
  });

  await notifier.notify({ trigger: 'run', runId: 'run-1', state: 'completed', text: 'done' });

  const widget = sent.find((message) => message.data?.kind === 'widget');
  assert.ok(widget, 'a widget companion must be sent');
  assert.equal(widget.data.widget.status, 'Disconnected');
  assert.equal(widget.data.widget.connected, false);
});

test('the widget withholds the newest result when the device declined rich bodies', async () => {
  const tokens = {
    listEnabled: async () => [row({ widgetUpdates: true, richBody: false })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'run', runId: 'run-1', state: 'completed', text: 'deployed the fix' });

  const widget = sent.find((message) => message.data?.kind === 'widget');
  assert.ok(widget, 'a widget companion must be sent');
  assert.equal('result' in widget.data.widget, false);
  assert.equal(widget.data.widget.work, 'No runs in flight');
});

test('no widget payload goes to a device that did not opt in', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'run', runId: 'run-1', state: 'completed', text: 'done' });

  assert.equal(sent.filter((message) => message.data?.kind === 'widget').length, 0);
  assert.equal(sent.length, 1);
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

test('widgetSnapshot words the Gate state for the home-screen card', () => {
  assert.deepEqual(widgetSnapshot(), {
    connected: true,
    work: 'No runs in flight',
    approvalsPending: 0,
  });
  assert.deepEqual(widgetSnapshot({ busyRuns: 1, approvalsPending: 2 }), {
    connected: true,
    work: '1 run in flight',
    approvalsPending: 2,
  });
  assert.deepEqual(widgetSnapshot({ busyRuns: 3, approvalsPending: 0 }), {
    connected: true,
    work: '3 runs in flight',
    approvalsPending: 0,
  });
  assert.equal(widgetSnapshot({ connected: false }).connected, false);
});

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

// The quiet-hours comparison is clock-dependent in production (it reads the
// device's local wall clock per row's timezone), so the fixture pins the clock
// through the injectable `now` seam and asserts BOTH edges of the interval —
// a fixed all-day window cannot do that without gambling on the moment verify
// runs (a run landing on the excluded edge minute used to flip this case).
// The row fixture uses timezone 'UTC', so a pinned UTC wall clock IS the
// device's local minute.
test('skips devices inside their local quiet hours at both edges of the window', async () => {
  const tokens = {
    listEnabled: async () => [row({ quietHours: { startMinutes: 600, endMinutes: 700 } })],
    removeByToken: async () => false,
  };
  const sent = [];

  for (const minuteOfDay of [600, 699]) {
    const notifier = createPushNotifier({
      tokens,
      send: async (messages) => { sent.push(...messages); return { ok: true }; },
      now: () => new Date(Date.UTC(2026, 8, 14, Math.floor(minuteOfDay / 60), minuteOfDay % 60)),
    });
    await notifier.notify({ trigger: 'final-response', sessionId: `session-${minuteOfDay}`, botId: 'bot-1', text: 'done' });
  }

  assert.deepEqual(sent, []);
});

test('a device outside its quiet window still receives the push at either edge', async () => {
  const tokens = {
    listEnabled: async () => [row({ quietHours: { startMinutes: 600, endMinutes: 700 } })],
    removeByToken: async () => false,
  };
  const sent = [];
  // 599 is the minute before the window, 700 the first minute after it
  // (the end is exclusive, per isQuiet's `nowMinutes < endMinutes`).
  for (const minuteOfDay of [599, 700]) {
    const notifier = createPushNotifier({
      tokens,
      send: async (messages) => { sent.push(...messages); return { ok: true }; },
      now: () => new Date(Date.UTC(2026, 8, 14, Math.floor(minuteOfDay / 60), minuteOfDay % 60)),
    });
    await notifier.notify({ trigger: 'final-response', sessionId: `session-${minuteOfDay}`, botId: 'bot-1', text: 'done' });
  }

  assert.equal(sent.length, 2);
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

test('the approval arm carries the category the app registered, so the banner shows buttons', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'approval', runId: 'run-1' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].categoryIdentifier, 'approval');
});

test('only the approval arm carries a category', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' });
  await notifier.notify({ trigger: 'run', runId: 'run-2' });
  await notifier.notify({ trigger: 'final-response', sessionId: 'cron_job2_20260911_090000', botId: 'scout', text: 'done' });

  assert.ok(sent.length >= 3);
  for (const message of sent) {
    assert.equal(message.categoryIdentifier, undefined);
  }
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

test('a result carrying several dead tokens leaves none of them in the store', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PushTokenStore } = await import('../core/push-tokens.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'gate-push-notifier-'));
  const tokens = new PushTokenStore(join(dir, 'push-tokens.json'));
  await tokens.upsert('phone-1', { expoPushToken: 'ExponentPushToken[dead-1]', enabled: true });
  await tokens.upsert('phone-2', { expoPushToken: 'ExponentPushToken[dead-2]', enabled: true });
  const notifier = createPushNotifier({
    tokens,
    send: async () => ({ ok: true, deadTokens: ['ExponentPushToken[dead-1]', 'ExponentPushToken[dead-2]'] }),
  });

  const result = await notifier.notify({ trigger: 'run', runId: 'run-1' });

  assert.equal(result.ok, true);
  assert.equal(await tokens.get('phone-1'), null);
  assert.equal(await tokens.get('phone-2'), null);
  assert.deepEqual(await tokens.listEnabled(), []);
});

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

// Quiet hours read the device's wall clock, so the fixture pins the clock
// through `now` and checks both edges of the window. The old fixed window
// (0–1439) flipped whenever the suite ran at 23:59 UTC, the excluded end minute.
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
  // 599 is the minute before the window; 700 is the first minute after it (the end is exclusive).
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

test('a device opted into approval exemptions gets the approval push even inside quiet hours', async () => {
  // The exemption is per-event-kind: a routine result in the same minute, for
  // the same opted-in device, stays silenced — only the blocking card runs.
  const tokens = {
    listEnabled: async () => [row({
      quietHours: { startMinutes: 600, endMinutes: 700 },
      quietHoursAllowApprovals: true,
    })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => { sent.push(...messages); return { ok: true }; },
    now: () => new Date(Date.UTC(2026, 8, 14, 10, 1)), // minute 601, inside the window
  });

  await notifier.notify({ trigger: 'approval', runId: 'run-7', environmentId: 'codex-local', operation: 'prompt' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, 'approvals');

  await notifier.notify({ trigger: 'run', runId: 'run-8', state: 'completed', sessionId: 'session-8' });

  assert.equal(sent.length, 1, 'a run verdict inside the window still waits until morning');
});

test('with the exemption off (or absent from the row), quiet hours silence approvals as before', async () => {
  for (const quietHoursAllowApprovals of [false, undefined]) {
    const tokens = {
      listEnabled: async () => [row({ quietHours: { startMinutes: 600, endMinutes: 700 }, quietHoursAllowApprovals })],
      removeByToken: async () => false,
    };
    const sent = [];
    const notifier = createPushNotifier({
      tokens,
      send: async (messages) => { sent.push(...messages); return { ok: true }; },
      now: () => new Date(Date.UTC(2026, 8, 14, 10, 1)),
    });

    await notifier.notify({ trigger: 'approval', runId: `run-9-${String(quietHoursAllowApprovals)}`, operation: 'prompt' });

    assert.deepEqual(sent, []);
  }
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

test('a cancelled run is titled as cancelled, not finished', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'run', runId: 'run-3', state: 'cancelled', text: 'cancelled' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Versutus cancelled a run');
});

test('a rich-body device gets the approval summary and the run failure', async () => {
  const tokens = {
    listEnabled: async () => [row({ richBody: true })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({
    trigger: 'approval',
    runId: 'run-4',
    operation: 'prompt',
    text: 'This task can modify files in its workspace — approve to let it start.',
  });
  await notifier.notify({
    trigger: 'run',
    runId: 'run-5',
    state: 'failed',
    text: 'task exceeded its 30s time limit and was stopped',
  });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].data.kind, 'approval');
  assert.match(sent[0].body, /modify files/);
  assert.equal(sent[1].title, 'Versutus hit an error');
  assert.match(sent[1].body, /time limit/);
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

test('every enabled device receives one event; one device cannot consume the dedupe slot', async () => {
  const tokens = {
    listEnabled: async () => [row({ expoPushToken: 'ExponentPushToken[token-1]' }), row({ expoPushToken: 'ExponentPushToken[token-2]' })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' });

  assert.deepEqual(
    sent.map((message) => message.to).sort(),
    ['ExponentPushToken[token-1]', 'ExponentPushToken[token-2]'],
    'both enabled devices must appear in the send batch',
  );

  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' });
  assert.equal(sent.length, 2, 'a replayed event still stays deduped across the fleet');
});

test('two distinct replies in one Session each reach the device', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'first turn' });
  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'second turn' });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].body ?? '', '');
  assert.equal(sent[0].data.sessionId, 'session-1');
});

test('replaying the same turn event still sends at most one reply notification', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });
  const event = { trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'same turn' };

  await notifier.notify(event);
  await notifier.notify(event);

  assert.equal(sent.length, 1);
});

// The notifier used to key a chat reply on sessionId + text, so a Session whose
// next turn happened to read identically to the last one stayed silent. The
// emission seam now attaches a per-turn id; two replies that share text but not
// their turn id are two turns, and each notifies.
test('two consecutive final responses with identical text and distinct turn ids each notify', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'same text', turnId: 'turn-1' });
  await notifier.notify({ trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'same text', turnId: 'turn-2' });

  assert.equal(sent.length, 2, 'two replies with the same text but distinct turn ids must both notify');
  assert.equal(sent[0].data.sessionId, 'session-1');
  assert.equal(sent[1].data.sessionId, 'session-1');
});

test('replaying a turn event with a turn id stays deduped', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });
  const event = { trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'same text', turnId: 'turn-1', state: 'completed' };

  await notifier.notify(event);
  await notifier.notify(event);

  assert.equal(sent.length, 1, 'a replayed final response keeps its one notification');
  assert.equal(sent[0].data.sessionId, 'session-1');
});

test('a final response without a turn id still dedupes on its text', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });
  const event = { trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'same text' };

  await notifier.notify(event);
  await notifier.notify(event);

  assert.equal(sent.length, 1, 'a legacy event without a turn id still collapses a replay on its text');
});

// The dedupe slot is claimed before the device loop, so a transport failure
// (push-send returns { ok: false }) would otherwise retire the event with no
// message ever delivered. The key must be forgotten on a failed batch so a
// later notify can try again — while a successful send keeps it pinned.
test('a failed Expo delivery keeps the event eligible for a later retry', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  let failFirst = true;
  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => {
      sent.push(...messages);
      if (failFirst) return { ok: false, error: new Error('network outage') };
      return { ok: true };
    },
  });
  const event = { trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' };

  await notifier.notify(event);
  assert.equal(sent.length, 1, 'the first attempt still builds and hands over the batch');
  assert.equal(sent[0].data.sessionId, 'session-1');

  failFirst = false;
  await notifier.notify(event);
  assert.equal(sent.length, 2, 'the same event is sent again after the failed delivery');
  assert.equal(sent[1].data.sessionId, 'session-1');
  assert.deepEqual(sent[0], sent[1], 'the retry carries the identical message');
});

// The dedupe slot is claimed before the device roster is read, so a roster that
// comes up short — a store that is missing or still half-written, a device
// momentarily not enabled — used to retire the only notice that exists to reach a
// phone which is not connected, with `ok: true` and nothing to show for it.
test('a roster that comes up short does not retire the event\u2019s one notice', async () => {
  let reads = 0;
  const tokens = {
    // What push-tokens.mjs really does with a store it cannot read: an empty
    // roster, with no error anywhere.
    listEnabled: async () => (reads += 1) === 1 ? [] : [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });
  const event = { trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' };

  const first = await notifier.notify(event);
  assert.deepEqual({ ok: first.ok, sent: first.sent }, { ok: true, sent: 0 }, 'nothing was delivered');

  const second = await notifier.notify(event);
  assert.equal(second.ok, true);
  assert.equal(sent.length, 1, 'the same event reaches the device once the roster answers');
  assert.equal(sent[0].data.sessionId, 'session-1');
});

test('a device silenced by quiet hours keeps the claim', async () => {
  // The opposite case, and it must not change: the device is there and policy
  // chose not to speak, so this is not a lost notice.
  const tokens = {
    listEnabled: async () => [row({ quietHours: { startMinutes: 600, endMinutes: 700 } })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => { sent.push(...messages); return { ok: true }; },
    now: () => new Date(Date.UTC(2026, 8, 14, 10, 1)), // minute 601, inside the window
  });
  const event = { trigger: 'final-response', sessionId: 'session-1', botId: 'bot-1', text: 'done' };

  await notifier.notify(event);
  await notifier.notify(event);

  assert.deepEqual(sent, [], 'a quiet device is not notified, and a replay does not change that');
});

test('two scheduled executions of one job each notify, while a replay stays deduped', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });
  const morning = { trigger: 'final-response', sessionId: 'cron_job1_20260916_090000', botId: 'scout', text: 'morning run' };
  const evening = { trigger: 'final-response', sessionId: 'cron_job1_20260916_180000', botId: 'scout', text: 'evening run' };

  await notifier.notify(morning);
  await notifier.notify(evening);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].data.jobId, 'job1');

  await notifier.notify(morning);
  assert.equal(sent.length, 2, 'a replayed execution must not notify twice');
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

test('a cron final response without a bot id is withheld — no destination to name', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({
    trigger: 'final-response',
    sessionId: 'cron_job1_20260911_090000',
    text: 'routine finished',
    state: 'completed',
  });

  assert.equal(sent.length, 0, 'an unaddressable routine must not populate the tray');
});

test('a direct routine trigger without a bot id is withheld — no destination to name', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'routine', jobId: 'job-1' });

  assert.equal(sent.length, 0);
});

test('a direct routine trigger with a bot id still delivers the routine payload', async () => {
  const tokens = {
    listEnabled: async () => [row()],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({ tokens, send: async (messages) => { sent.push(...messages); return { ok: true }; } });

  await notifier.notify({ trigger: 'routine', jobId: 'job-1', botId: 'scout' });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data, { kind: 'routine', jobId: 'job-1', botId: 'scout' });
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
    snapshot: () => ({ work: '2 runs in flight', approvalsPending: 3 }),
  });

  await notifier.notify({ trigger: 'run', runId: 'run-1', state: 'completed', text: 'done' });

  const widget = sent.find((message) => message.data?.kind === 'widget');
  assert.ok(widget, 'a widget companion must be sent');
  // No connection word: the Gate has no reading of the phone's link to it, so
  // a push-written card says only that the Gate updated it (WIDGET-6).
  assert.equal(widget.data.widget.status, 'Updated');
  assert.equal(widget.data.widget.work, '2 runs in flight');
  assert.equal(widget.data.widget.approvalsPending, 3);
});

test('a snapshot provider claiming a connection cannot put that claim on the card', async () => {
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
  assert.equal('connected' in widget.data.widget, false);
  assert.notEqual(widget.data.widget.status, 'Disconnected');
  assert.notEqual(widget.data.widget.status, 'Connected');
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

// Expo produces receipts asynchronously (~15 minutes), so the notifier
// schedules one deferred collection per batch instead of polling inline.
// This test wires the REAL createPushSend (fake fetch returning one
// DeviceNotRegistered receipt) to the REAL PushTokenStore and the REAL
// notifier: the receipt names a ticket id, and only the ticket-to-token map
// from send() lets the prune find the stored expo push token. A fake
// collectReceipts returning a token directly would hide a broken translation.
test('deferred receipt collection prunes a dead device found by real receipts', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PushTokenStore } = await import('../core/push-tokens.mjs');
  const { createPushSend } = await import('../core/push-send.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'gate-push-notifier-receipts-'));
  const tokens = new PushTokenStore(join(dir, 'push-tokens.json'));
  await tokens.upsert('phone-1', { expoPushToken: 'ExponentPushToken[dead-1]', enabled: true });

  const pushSend = createPushSend({
    fetchImpl: async (url, init) => {
      if (String(url).includes('getReceipts')) {
        const { ids } = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: Object.fromEntries(ids.map((id) => [id, { details: { error: 'DeviceNotRegistered' } }])) };
          },
        };
      }
      const messages = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: messages.map((entry, index) => ({ status: 'ok', id: `ticket-${index}` })) };
        },
      };
    },
  });

  const collected = [];
  const notifier = createPushNotifier({
    tokens,
    send: pushSend.send,
    collectReceipts: async (ids, ticketTokens) => {
      collected.push([ids, ticketTokens]);
      return pushSend.collectReceipts(ids, ticketTokens);
    },
    // The deferral has to outlive this test's own awaits, or the "not inline"
    // assertion below measures how fast the machine read a file rather than
    // whether the collection was deferred at all.
    receiptDelayMs: 250,
  });

  const result = await notifier.notify({ trigger: 'run', runId: 'run-1' });

  assert.equal(result.ok, true);
  assert.notEqual(await tokens.get('phone-1'), null, 'the dead device survives until the receipts exist');
  assert.deepEqual(collected, [], 'receipts are not collected inline');

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(
    collected,
    [[['ticket-0'], { 'ticket-0': 'ExponentPushToken[dead-1]' }]],
    'one deferred collection per batch, with the ticket-to-token map',
  );
  assert.equal(await tokens.get('phone-1'), null, 'the dead device is pruned after the deferred collection');
});

test('a failed send schedules no receipt collection', async () => {
  const collected = [];
  const notifier = createPushNotifier({
    tokens: {
      listEnabled: async () => [row()],
      removeByToken: async () => false,
    },
    send: async () => ({ ok: false, error: new Error('offline') }),
    collectReceipts: async (ids) => { collected.push(ids); return { ok: true, receipts: [], deadTokens: [] }; },
    receiptDelayMs: 10,
  });

  const result = await notifier.notify({ trigger: 'run', runId: 'run-1' });

  assert.equal(result.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(collected, []);
});

test('a receipt collection failure is swallowed and logged', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const notifier = createPushNotifier({
      tokens: {
        listEnabled: async () => [row()],
        removeByToken: async () => false,
      },
      send: async () => ({ ok: true, tickets: [{ status: 'ok', id: 'ticket-1' }] }),
      collectReceipts: async () => { throw new Error('receipts offline'); },
      receiptDelayMs: 250,
    });

    await notifier.notify({ trigger: 'run', runId: 'run-1' });
    await new Promise((resolve) => setTimeout(resolve, 600));
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((line) => line.includes('receipts offline')));
});

test('widgetSnapshot words the Gate state for the home-screen card', () => {
  // No `connected` key: the Gate cannot see the phone's link to it (WIDGET-6).
  assert.deepEqual(widgetSnapshot(), {
    work: 'No runs in flight',
    approvalsPending: 0,
  });
  assert.deepEqual(widgetSnapshot({ busyRuns: 1, approvalsPending: 2 }), {
    work: '1 run in flight',
    approvalsPending: 2,
  });
  assert.deepEqual(widgetSnapshot({ busyRuns: 3, approvalsPending: 0 }), {
    work: '3 runs in flight',
    approvalsPending: 0,
  });
  assert.equal('connected' in widgetSnapshot({ connected: true }), false);
});

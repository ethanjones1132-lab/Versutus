import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPushNotifier, widgetSnapshot } from '../core/push-notifier.mjs';

function row(overrides = {}) {
  return {
    expoPushToken: 'ExponentPushToken[token-1]',
    platform: 'android',
    timezone: 'UTC',
    enabled: true,
    richBody: true,
    botIds: [],
    quietHours: null,
    ...overrides,
  };
}

async function companionFor(snapshot) {
  const tokens = {
    listEnabled: async () => [row({ widgetUpdates: true })],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => { sent.push(...messages); return { ok: true }; },
    ...(snapshot === undefined ? {} : { snapshot }),
  });
  await notifier.notify({ trigger: 'run', runId: 'run-1', state: 'completed', text: 'done' });
  const companion = sent.find((message) => message.data?.kind === 'widget');
  assert.ok(companion, 'a widget companion must be sent to a device that opted in');
  return companion;
}

test('the Gate claims nothing about the phone\u2019s link, in any snapshot it builds', () => {
  assert.equal('connected' in widgetSnapshot(), false);
  assert.equal('connected' in widgetSnapshot({ busyRuns: 2, approvalsPending: 1 }), false);
});

test('no provider of a snapshot can put a connection claim back into the card', async () => {
  // Even a caller that hands the notifier a `connected` of its own: the Gate
  // has no reading of the phone's link to the Gate, whatever it is handed.
  for (const snapshot of [
    undefined,
    { connected: true, work: 'No runs in flight', approvalsPending: 0 },
    { connected: false, work: 'No runs in flight', approvalsPending: 0 },
    () => ({ connected: true, work: 'No runs in flight', approvalsPending: 0 }),
  ]) {
    const widget = (await companionFor(snapshot)).data.widget;
    assert.equal('connected' in widget, false);
    assert.notEqual(widget.status, 'Connected');
    assert.notEqual(widget.status, 'Disconnected');
  }
});

test('the card a push writes says what it is: an update, stamped', async () => {
  const widget = (await companionFor(() => widgetSnapshot({ busyRuns: 2 }))).data.widget;

  assert.deepEqual(widget, {
    v: 2,
    status: 'Updated',
    work: '2 runs in flight',
    result: 'done',
    approvalsPending: 0,
    writtenAt: widget.writtenAt,
  });
  assert.equal(typeof widget.writtenAt, 'number');
});

test('a snapshot provider that throws still yields a card that claims nothing', async () => {
  const widget = (await companionFor(() => { throw new Error('no state'); })).data.widget;

  assert.equal('connected' in widget, false);
  assert.equal(widget.work, 'No runs in flight');
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPushNotifier } from '../core/push-notifier.mjs';

/**
 * The category id the phone registers at boot. The Gate cannot import the app's
 * TypeScript module, so the string is pinned here twice: against the Gate's
 * constant and against `src/lib/notifications/categories.ts`, which is where
 * the phone registers `BOT_MESSAGE_CATEGORY_ID`. Android attaches action rows
 * only when the notification content carries a category, and for a push that
 * content field is the FCM data key `categoryId` — a documented field of the
 * Expo push message ("Send notifications with the Expo Push Service",
 * Message request format).
 */
const PHONE_CATEGORY_ID = 'botmessage';
const phoneCategories = fileURLToPath(new URL('../../src/lib/notifications/categories.ts', import.meta.url));

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

async function notifyWith(event, overrides = {}) {
  const tokens = {
    listEnabled: async () => [row(overrides)],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => { sent.push(...messages); return { ok: true }; },
  });
  await notifier.notify(event);
  return sent;
}

test('the category the Gate sends is the one the phone registers', () => {
  const source = readFileSync(phoneCategories, 'utf8');
  assert.match(
    source,
    new RegExp(`BOT_MESSAGE_CATEGORY_ID\\s*=\\s*'${PHONE_CATEGORY_ID}'`),
    'the Gate must send the exact category id the phone registered, or Android shows no Reply button',
  );
});

test('a relayed reply carries the bot-message category, so the notice has a Reply button', async () => {
  const sent = await notifyWith({
    trigger: 'final-response',
    sessionId: 'session-1',
    turnId: 'turn-1',
    botId: 'bot-1',
    text: 'the deploy is done',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].categoryId, PHONE_CATEGORY_ID);
  // The payload the Reply action reads stays the one it was written for.
  assert.deepEqual(sent[0].data, { kind: 'reply', sessionId: 'session-1', botId: 'bot-1' });
});

test('the reply category rides alongside every other field the notice had', async () => {
  const sent = await notifyWith({
    trigger: 'final-response',
    sessionId: 'session-2',
    turnId: 'turn-2',
    botId: 'bot-1',
    text: 'the deploy is done',
  });

  assert.deepEqual(sent[0], {
    to: 'ExponentPushToken[token-1]',
    title: 'bot-1 finished a reply',
    body: 'the deploy is done',
    data: { kind: 'reply', sessionId: 'session-2', botId: 'bot-1' },
    channelId: 'model-replies',
    sound: 'default',
    categoryId: PHONE_CATEGORY_ID,
  });
});

test('a reply that names no Bot claims no category: the Reply button would post nowhere', async () => {
  // A turn posted without `?bot=`/`body.bot` is a real event (server.mjs only
  // puts `botId` on the notice when one was named), and the phone's
  // `botReplyFromResponse` refuses a payload without `botId`, so a category on
  // this notice would show a Reply button that sends nothing.
  const sent = await notifyWith({
    trigger: 'final-response',
    sessionId: 'session-3',
    turnId: 'turn-3',
    text: 'an answer to nobody in particular',
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data, { kind: 'reply', sessionId: 'session-3' });
  assert.equal('categoryId' in sent[0], false);
});

test('a run verdict claims no category — no approval buttons, and no reply button that cannot be honoured', async () => {
  const sent = await notifyWith({ trigger: 'run', runId: 'run-1', state: 'completed', text: 'done' });

  assert.equal(sent.length, 1);
  assert.equal('categoryId' in sent[0], false);
});

test('an approval notice claims no category', async () => {
  const sent = await notifyWith({ trigger: 'approval', runId: 'run-2' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.kind, 'approval');
  assert.equal('categoryId' in sent[0], false);
});

test('a routine notice claims no category', async () => {
  const sent = await notifyWith({ trigger: 'routine', jobId: 'job-1', botId: 'scout', text: 'morning' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.kind, 'routine');
  assert.equal('categoryId' in sent[0], false);
});

test('a reply that a routine produced carries no category: the operator replies to a Bot, not a cron job', async () => {
  const sent = await notifyWith({
    trigger: 'final-response',
    sessionId: 'cron_job1_20260916_090000',
    botId: 'scout',
    text: 'morning run',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.kind, 'routine');
  assert.equal('categoryId' in sent[0], false);
});
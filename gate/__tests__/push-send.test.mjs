import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPushSend } from '../core/push-send.mjs';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

function message(index) {
  return {
    to: `ExponentPushToken[token-${index}]`,
    title: 'Finished',
    body: '',
    data: { kind: 'reply', sessionId: `session-${index}` },
    channelId: 'model-replies',
    sound: 'default',
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

// Expo produces receipts asynchronously (~15 minutes), so send() must not
// poll for them inline: every notification would pay a second round trip and
// find nothing. Receipt collection is deferred (see push-notifier.mjs).
test('sends 101 messages in two chunks without a receipts round trip', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const messages = JSON.parse(init.body);
    return response({
      data: messages.map((entry, index) => ({
        status: 'ok',
        id: `ticket-${calls.filter((call) => call.url === SEND_URL).length - 1}-${index}`,
      })),
    });
  };
  const sender = createPushSend({ fetchImpl });
  const messages = Array.from({ length: 101 }, (_, index) => message(index));

  const result = await sender.send(messages);

  assert.equal(result.ok, true);
  assert.equal(result.tickets.length, 101);
  assert.deepEqual(result.receipts, []);
  assert.deepEqual(result.deadTokens, []);
  const sendBodies = calls
    .filter((call) => call.url === SEND_URL)
    .map((call) => JSON.parse(call.init.body));
  assert.deepEqual(sendBodies.map((body) => body.length), [100, 1]);
  assert.equal(calls.filter((call) => call.url === RECEIPTS_URL).length, 0);
});

test('a ticket saying DeviceNotRegistered still reports its token as dead', async () => {
  const fetchImpl = async (url, init) => {
    const messages = JSON.parse(init.body);
    return response({
      data: messages.map((entry, index) => ({
        status: index === 0 ? 'ok' : 'error',
        ...(index === 0 ? { id: 'ticket-1' } : { details: { error: 'DeviceNotRegistered' } }),
      })),
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send([message(1), message(2)]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.deadTokens, ['ExponentPushToken[token-2]']);
  assert.deepEqual(result.receipts, []);
});

test('a 200 response with mixed ticket statuses keeps every ticket', async () => {
  const fetchImpl = async (url, init) => {
    const messages = JSON.parse(init.body);
    return response({
      data: messages.map((entry, index) => ({
        status: index === 1 ? 'error' : 'ok',
        ...(index === 1 ? { details: { error: 'DeviceNotRegistered' } } : { id: `ticket-${index}` }),
      })),
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send([message(0), message(1), message(2)]);

  assert.equal(result.ok, true);
  assert.equal(result.tickets.length, 3);
  assert.deepEqual(result.deadTokens, ['ExponentPushToken[token-1]']);
  assert.deepEqual(result.receipts, []);
});

test('network failure is returned without throwing', async () => {
  const failure = new Error('offline');
  const sender = createPushSend({
    fetchImpl: async () => { throw failure; },
  });

  await assert.doesNotReject(() => sender.send([message(0)]));
  const result = await sender.send([message(0)]);
  assert.equal(result.ok, false);
  assert.equal(result.error, failure);
});

test('collectReceipts returns receipts and dead tokens without throwing on failure', async () => {
  const sender = createPushSend({
    fetchImpl: async () => { throw new Error('offline'); },
  });

  await assert.doesNotReject(() => sender.collectReceipts(['ticket-1']));
  const result = await sender.collectReceipts(['ticket-1']);
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'offline');
});

test('collectReceipts reports the receipt shape and translates dead ticket ids to push tokens', async () => {
  const fetchImpl = async (url, init) => {
    const { ids } = JSON.parse(init.body);
    const data = {
      'ticket-1': { status: 'ok' },
      'ticket-2': { details: { error: 'DeviceNotRegistered' } },
    };
    return response({ data: Object.fromEntries(ids.map((id) => [id, data[id]])) });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.collectReceipts(
    ['ticket-1', 'ticket-2'],
    { 'ticket-1': 'ExponentPushToken[token-1]', 'ticket-2': 'ExponentPushToken[token-2]' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.receipts, [
    { id: 'ticket-1', status: 'ok' },
    { id: 'ticket-2', details: { error: 'DeviceNotRegistered' } },
  ]);
  assert.deepEqual(result.deadTokens, ['ExponentPushToken[token-2]'], 'dead tokens are push tokens, not ticket ids');
});

test('collectReceipts chunks at 1000 ids', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { ids } = JSON.parse(init.body);
    calls.push(ids);
    return response({ data: {} });
  };
  const sender = createPushSend({ fetchImpl });
  const ids = Array.from({ length: 1001 }, (_, index) => `ticket-${index}`);

  const result = await sender.collectReceipts(ids);

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((chunk) => chunk.length), [1000, 1]);
});

test('collectReceipts reports ok:false when the Expo response carries errors', async () => {
  const sender = createPushSend({
    fetchImpl: async () => response({ errors: [{ code: 'rate_limited', message: 'slow down' }] }),
  });

  const result = await sender.collectReceipts(['ticket-1']);

  assert.equal(result.ok, false);
  assert.match(result.error.message, /slow down/);
});

test('a receipt with a non-DeviceNotRegistered error passes through without being dead', async () => {
  const sender = createPushSend({
    fetchImpl: async () => response({
      data: { 'ticket-1': { details: { error: 'MessageTooBig' } } },
    }),
  });

  const result = await sender.collectReceipts(['ticket-1'], { 'ticket-1': 'ExponentPushToken[token-1]' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.receipts, [{ id: 'ticket-1', details: { error: 'MessageTooBig' } }]);
  assert.deepEqual(result.deadTokens, []);
});

test('send returns the ticket-to-token map the deferred receipt collection needs', async () => {
  const fetchImpl = async (url, init) => {
    if (url === RECEIPTS_URL) {
      const { ids } = JSON.parse(init.body);
      return response({ data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) });
    }
    const messages = JSON.parse(init.body);
    return response({
      data: messages.map((entry, index) => ({ status: 'ok', id: `ticket-${index}` })),
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send([message(1), message(2)]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ticketTokens, {
    'ticket-0': 'ExponentPushToken[token-1]',
    'ticket-1': 'ExponentPushToken[token-2]',
  });

  // The deferred collection can now translate receipt ids back to the tokens
  // the store prunes by — the regression this map exists for.
  const receipts = await sender.collectReceipts(
    result.tickets.map((ticket) => ticket.id),
    result.ticketTokens,
  );
  assert.equal(receipts.ok, true);
  assert.equal(receipts.receipts.length, 2);
  assert.deepEqual(receipts.deadTokens, [], 'no receipts were requested with a DeviceNotRegistered detail');
});

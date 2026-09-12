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

test('sends 101 messages in two chunks and collects every successful ticket receipt', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === SEND_URL) {
      const messages = JSON.parse(init.body);
      return response({
        data: messages.map((entry, index) => ({
          status: 'ok',
          id: `ticket-${calls.filter((call) => call.url === SEND_URL).length - 1}-${index}`,
        })),
      });
    }
    const ids = JSON.parse(init.body).ids;
    // All 101 successful tickets ride in one receipts call (chunk size 1000);
    // spot-check the chunk boundaries rather than pin the full 101-id array.
    assert.equal(ids.length, 101);
    assert.ok(ids.includes('ticket-0-0'));
    assert.ok(ids.includes('ticket-0-99'));
    assert.ok(ids.includes('ticket-1-0'));
    return response({ data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) });
  };
  const sender = createPushSend({ fetchImpl });
  const messages = Array.from({ length: 101 }, (_, index) => message(index));

  const result = await sender.send(messages);

  assert.equal(result.ok, true);
  assert.equal(result.tickets.length, 101);
  assert.equal(result.receipts.length, 101);
  assert.deepEqual(result.deadTokens, []);
  const sendBodies = calls
    .filter((call) => call.url === SEND_URL)
    .map((call) => JSON.parse(call.init.body));
  assert.deepEqual(sendBodies.map((body) => body.length), [100, 1]);
  assert.equal(calls.filter((call) => call.url === RECEIPTS_URL).length, 1);
});

test('returns a token for a DeviceNotRegistered receipt', async () => {
  const fetchImpl = async (url, init) => {
    if (url === SEND_URL) {
      return response({ data: [{ status: 'ok', id: 'ticket-1' }] });
    }
    return response({
      data: {
        'ticket-1': {
          status: 'error',
          details: { error: 'DeviceNotRegistered' },
        },
      },
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send([message(1)]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.deadTokens, ['ExponentPushToken[token-1]']);
  assert.equal(result.receipts[0].to, 'ExponentPushToken[token-1]');
  assert.equal(result.receipts[0].details.error, 'DeviceNotRegistered');
});

test('a 200 response with mixed ticket statuses still inspects every receipt', async () => {
  const fetchImpl = async (url, init) => {
    if (url === SEND_URL) {
      const messages = JSON.parse(init.body);
      return response({
        data: messages.map((entry, index) => ({
          status: index === 1 ? 'error' : 'ok',
          ...(index === 1 ? { details: { error: 'DeviceNotRegistered' } } : { id: `ticket-${index}` }),
        })),
      });
    }
    const ids = JSON.parse(init.body).ids;
    assert.deepEqual(ids, ['ticket-0', 'ticket-2']);
    return response({
      data: {
        'ticket-0': { status: 'ok' },
        'ticket-2': { status: 'error', details: { error: 'MessageTooBig' } },
      },
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send([message(0), message(1), message(2)]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.deadTokens, ['ExponentPushToken[token-1]']);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts.find((receipt) => receipt.to === 'ExponentPushToken[token-2]')?.details.error, 'MessageTooBig');
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

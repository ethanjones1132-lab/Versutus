import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPushSend } from '../core/push-send.mjs';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';

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
    async text() { return JSON.stringify(body); },
  };
}

function messages(count) {
  return Array.from({ length: count }, (_, index) => message(index));
}

// send() posts 100 messages at a time. When a LATER chunk fails, Expo has
// already accepted the earlier chunks: their tickets (and the ticket-to-token
// map the deferred receipt collection prunes by) are the only handle on those
// delivered messages. Returning a bare { ok: false } threw them away, so a dead
// device in a delivered chunk was never pruned. This pins the partial result.
test('a failed later chunk keeps the tickets already delivered by earlier chunks', async () => {
  let sendCalls = 0;
  const fetchImpl = async (url, init) => {
    sendCalls += 1;
    const chunk = JSON.parse(init.body);
    if (sendCalls === 2) throw new Error('connection reset on chunk 2');
    return response({
      data: chunk.map((entry, index) => ({
        status: entry.to === 'ExponentPushToken[token-5]' ? 'error' : 'ok',
        ...(entry.to === 'ExponentPushToken[token-5]'
          ? { details: { error: 'DeviceNotRegistered' } }
          : { id: `ticket-${sendCalls - 1}-${index}` }),
      })),
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send(messages(250));

  assert.equal(result.ok, false, 'the batch as a whole did not fully deliver');
  assert.match(result.error.message, /connection reset/);

  // The first 100 messages reached Expo, so their tickets must survive.
  assert.equal(result.delivered, 100);
  assert.equal(result.failedChunk, 1, 'the failing chunk is reported (zero-based)');
  assert.equal(result.tickets.length, 100);
  assert.deepEqual(result.ticketTokens['ticket-0-0'], 'ExponentPushToken[token-0]');
  assert.deepEqual(result.ticketTokens['ticket-0-99'], 'ExponentPushToken[token-99]');
  assert.equal(result.ticketTokens['ticket-1-0'], undefined, 'the failed chunk contributed no tickets');

  // A dead device found in the delivered chunk stays visible to the caller.
  assert.deepEqual(result.deadTokens, ['ExponentPushToken[token-5]']);
  assert.deepEqual(result.receipts, []);
});

test('a failure on the last of three chunks keeps the first two chunks\u2019 tickets', async () => {
  let sendCalls = 0;
  const fetchImpl = async (url, init) => {
    sendCalls += 1;
    const chunk = JSON.parse(init.body);
    if (sendCalls === 3) return response({ errors: [{ code: 'rate_limited', message: 'slow down' }] });
    return response({
      data: chunk.map((entry, index) => ({ status: 'ok', id: `ticket-${sendCalls - 1}-${index}` })),
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send(messages(250));

  assert.equal(result.ok, false);
  assert.match(result.error.message, /slow down/);
  assert.equal(result.delivered, 200);
  assert.equal(result.failedChunk, 2);
  assert.equal(result.tickets.length, 200);
  assert.equal(Object.keys(result.ticketTokens).length, 200, 'every delivered ticket keeps its push token');
  assert.equal(result.ticketTokens['ticket-1-99'], 'ExponentPushToken[token-199]');
  assert.deepEqual(result.deadTokens, []);
});

test('a first-chunk failure reports no delivered tickets and names chunk 0', async () => {
  const sender = createPushSend({
    fetchImpl: async () => response({ message: 'gateway error' }, 502),
  });

  const result = await sender.send(messages(150));

  assert.equal(result.ok, false);
  assert.match(result.error.message, /gateway error/);
  assert.deepEqual(result.tickets, []);
  assert.deepEqual(result.ticketTokens, {});
  assert.deepEqual(result.receipts, []);
  assert.deepEqual(result.deadTokens, []);
  assert.equal(result.delivered, 0);
  assert.equal(result.failedChunk, 0);
});

// Callers already treat { ok: true, tickets, ticketTokens, receipts, deadTokens }
// as the successful shape. The partial-progress fields belong to the failure
// path only, so an all-success batch stays byte-for-byte the same result.
test('an all-success batch keeps the existing result shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const chunk = JSON.parse(init.body);
    calls.push(chunk.length);
    return response({
      data: chunk.map((entry, index) => ({ status: 'ok', id: `ticket-${calls.length - 1}-${index}` })),
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send(messages(101));

  assert.deepEqual(calls, [100, 1], 'still chunks at 100');
  assert.deepEqual(Object.keys(result).sort(), ['deadTokens', 'ok', 'receipts', 'ticketTokens', 'tickets']);
  assert.equal(result.ok, true);
  assert.equal(result.tickets.length, 101);
  assert.equal(Object.keys(result.ticketTokens).length, 101);
  assert.deepEqual(result.receipts, []);
  assert.deepEqual(result.deadTokens, []);
});

// A partial result must still line up with the messages it came from: the
// tickets of delivered chunks are in send order, so index i is the ticket for
// messages[i].
test('delivered tickets stay in send order after a later chunk fails', async () => {
  let sendCalls = 0;
  const fetchImpl = async (url, init) => {
    sendCalls += 1;
    if (sendCalls === 2) throw new Error('offline');
    const chunk = JSON.parse(init.body);
    return response({
      data: chunk.map((entry, index) => ({ status: 'ok', id: `ticket-${String(index).padStart(3, '0')}` })),
    });
  };
  const sender = createPushSend({ fetchImpl });

  const result = await sender.send(messages(250));

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.tickets.map((ticket) => ticket.id),
    Array.from({ length: 100 }, (_, index) => `ticket-${String(index).padStart(3, '0')}`),
  );
});

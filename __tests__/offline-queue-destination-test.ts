// The durable outbox row's destination. A reply typed on a bot-message notice
// names the Bot Chat it was for (src/lib/notifications/bot-reply.ts), and that
// destination has to ride the queue with the text: without it the flush below
// hands the words to whichever conversation the client holds when the
// connection returns (FUTURE-ITEMS.md §6).

const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import {
  durableQueueRows,
  loadOfflineQueue,
  saveOfflineQueue,
  type OfflineQueueItem,
} from '@/lib/gateway/session-persistence';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The device storage key the outbox lives under. */
const OFFLINE_QUEUE_KEY = 'versutus:offline-queue';

/** Put a stored payload (or a legacy one) where the loader will read it. */
function stored(raw: unknown): void {
  mockStore.set(OFFLINE_QUEUE_KEY, JSON.stringify(raw));
}

/** A draft is a reply until it names a Bot Chat. */
function row(overrides: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: 'item-1',
    text: 'on my way',
    gatewayId: 'gw-1',
    createdAt: 1757400000000,
    ...overrides,
  };
}

describe('the outbox row remembers the Bot Chat a reply was typed for', () => {
  test('a reply to a notice writes its Bot and session beside the text, and reads them back', async () => {
    mockStore.clear();
    const item = row({ botId: 'scout', sessionId: 'sess-1' });

    await saveOfflineQueue([item]);

    expect(await loadOfflineQueue()).toEqual([item]);
  });

  test('a row with no destination round-trips unchanged — a composer line is what it always was', async () => {
    mockStore.clear();
    const item = row();

    await saveOfflineQueue([item]);
    const [loaded] = await loadOfflineQueue();

    expect(loaded).toEqual(item);
    // Not "the key is there and falsy": an item that named no Bot Chat must not
    // carry one, or a later reader could mistake the field for a destination.
    expect(Object.keys(loaded)).not.toContain('botId');
    expect(Object.keys(loaded)).not.toContain('sessionId');
  });

  test('each row keeps its own destination — one queue can hold two Bot Chats', async () => {
    mockStore.clear();

    await saveOfflineQueue([
      row({ id: 'a', botId: 'scout', sessionId: 'sess-1' }),
      row({ id: 'b', botId: 'scribe', sessionId: 'sess-2' }),
      row({ id: 'c' }),
    ]);

    const loaded = await loadOfflineQueue();

    expect(loaded.map((item) => [item.id, item.botId, item.sessionId])).toEqual([
      ['a', 'scout', 'sess-1'],
      ['b', 'scribe', 'sess-2'],
      ['c', undefined, undefined],
    ]);
  });

  test('a row stored before this field existed loads with no destination', async () => {
    stored([{ id: 'old', text: 'typed offline', gatewayId: 'gw-1', createdAt: 7 }]);

    expect(await loadOfflineQueue()).toEqual([
      { id: 'old', text: 'typed offline', gatewayId: 'gw-1', createdAt: 7 },
    ]);
  });
});

describe('a destination this app cannot read is no destination', () => {
  test('an id that is not a present string is dropped, and the row keeps the words', async () => {
    stored([
      { id: 'a', text: 'one', gatewayId: 'gw-1', createdAt: 1, botId: 7, sessionId: 'sess-1' },
      { id: 'b', text: 'two', gatewayId: 'gw-1', createdAt: 2, botId: '', sessionId: '' },
      { id: 'c', text: 'three', gatewayId: 'gw-1', createdAt: 3, botId: null },
    ]);

    const loaded = await loadOfflineQueue();

    // The words survive — the destination is what is unusable, not the line.
    expect(loaded.map((item) => item.text)).toEqual(['one', 'two', 'three']);
    expect(loaded.map((item) => item.botId)).toEqual([undefined, undefined, undefined]);
    // The half that IS readable still steers.
    expect(loaded[0].sessionId).toBe('sess-1');
  });

  test('a row missing a required field is still dropped, and a payload that is not a list loads as none', async () => {
    stored([{ id: 'a', text: 'one', gatewayId: 'gw-1' }]);
    expect(await loadOfflineQueue()).toEqual([]);

    stored({ item: 'not a list' });
    expect(await loadOfflineQueue()).toEqual([]);

    stored('nonsense');
    expect(await loadOfflineQueue()).toEqual([]);
  });
});

describe('the flush opens the Bot Chat a queued reply was for, before it sends', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
  const OPEN = 'await openBot(item.botId);';
  const SEND = 'await sendChatInput(item.text, { fromQueue: true, messageId: item.id });';

  /** The flush's loop, from the queue split to the end of the batch. */
  const flush = () =>
    between(
      provider(),
      '// Only flush items destined for the active gateway.',
      'flushingOfflineRef.current = false;',
    );

  test('a row that names a Bot opens that Bot Chat before its text moves', () => {
    const src = flush();

    expect(src).toContain('for (const item of forActive)');
    const guard = src.indexOf('if (item.botId) {');
    const open = src.indexOf(OPEN);
    const send = src.indexOf(SEND);

    expect(guard).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(guard);
    expect(send).toBeGreaterThan(open);
  });

  test('the screen is asked for that Bot Chat once the open lands, still ahead of the send', () => {
    const src = flush();
    const open = src.indexOf(OPEN);
    const request = src.indexOf("requestSurface({ kind: 'bot', botId: item.botId });");
    const send = src.indexOf(SEND);

    expect(request).toBeGreaterThan(open);
    expect(send).toBeGreaterThan(request);
    // Once: a reply is one destination, and a second request would re-apply a
    // surface the screen has already shown.
    expect(src.indexOf("requestSurface({ kind: 'bot'", request + 1)).toBe(-1);
  });

  test('a row with no destination takes no Bot path at all', () => {
    const src = flush();
    const guard = src.indexOf('if (item.botId) {');
    const block = between(src, 'if (item.botId) {', 'await sendChatInput(item.text');

    expect(src).toContain('for (const item of forActive)');
    expect(guard).toBeGreaterThan(-1);
    expect(block).toContain(OPEN);
    expect(block).not.toContain('sendChatInput(');
    // One open in the whole loop, and it is inside the guard: a composer line
    // never opens a Bot Chat, and never moves the screen onto one.
    expect(src.split('await openBot(').length - 1).toBe(1);
    expect(src.split('requestSurface(').length - 1).toBe(1);
  });

  test('a Bot Chat that could not be opened sends nothing, and the words stay queued', () => {
    const src = flush();
    const open = src.indexOf(OPEN);
    const catchAt = src.indexOf('} catch {', open);
    const body = src.slice(catchAt + 1, src.indexOf('}', catchAt + 1));
    const send = src.indexOf(SEND);

    expect(catchAt).toBeGreaterThan(open);
    expect(body).toContain('offlineQueueRef.current.push(item);');
    expect(body).toContain('continue;');
    // Nothing is sent on that path, and the row is persisted again rather than
    // dropped: the send would land in whichever conversation the client still
    // holds, and losing the words is worse than waiting for the next connection.
    expect(body).not.toContain('sendChatInput(');
    expect(send).toBeGreaterThan(catchAt);
  });

  test('sendChatInput is still the only thing that sends from the outbox', () => {
    const src = flush();

    expect(src).toContain('for (const item of forActive)');
    expect(src.split('sendChatInput(').length - 1).toBe(1);
    expect(src).toContain('messageId: item.id');
    // No second pipeline of its own.
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('gatewayRequest');
    expect(src).not.toContain('queueOfflineInput');
    expect(src).not.toContain('saveOfflineQueue');
  });

  test('the effect re-runs when the Bot path changes, so the open is the live one', () => {
    expect(provider()).toContain(
      '}, [isCommandRunning, isSending, openBot, persistOfflineQueue, requestSurface, sendChatInput, status]);',
    );
  });
});

describe('a flush that escapes mid-batch keeps the lines it has not sent', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
  const SEND = 'await sendChatInput(item.text, { fromQueue: true, messageId: item.id });';
  const CLEAR = 'unsent.delete(item);';
  const RESCUE = '// Re-queue anything that did not clear so a kill mid-flush is not data loss.';
  const RELEASE = 'flushingOfflineRef.current = false;';

  /** The batch: from the queue split to the moment the flush is released. */
  const flush = () =>
    between(provider(), '// Only flush items destined for the active gateway.', RELEASE);

  /** What takes over when the loop escapes — the rescue's comment to the release. */
  const rescue = () => between(provider(), RESCUE, RELEASE);

  test('the loop holds the rows it still owes, and a row is cleared only once its send returned', () => {
    const src = flush();
    const sent = src.indexOf(SEND);
    const cleared = src.indexOf(CLEAR, sent);

    expect(src).toContain('const unsent = new Set(forActive);');
    expect(sent).toBeGreaterThan(-1);
    // Clearing is what the send's return does, so a row whose send never came
    // back is still owed when the loop escapes below. The one clear source-line
    // ahead of the send is the Bot-open path's own put-back, asserted separately.
    expect(cleared).toBeGreaterThan(sent);
    // Exactly the two settles — the send, and the Bot-open path putting the row
    // back — so no third place can drop a line without saying so.
    expect(src.split(CLEAR).length - 1).toBe(2);
  });

  test('an escape puts every row it did not send back on the queue and persists them', () => {
    const body = rescue();

    expect(body).toContain('const stranded = forActive.filter((item) => unsent.has(item));');
    expect(body).toContain('offlineQueueRef.current.push(...stranded);');
    expect(body).toContain('persistOfflineQueue();');
    // The words are durable before the flush is released, so a connection that
    // returns later finds every line that never left — and nothing here sends.
    expect(body).not.toContain('sendChatInput(');
  });

  test('a row the Bot-open path already put back is settled once, never pushed twice', () => {
    const src = flush();
    const open = src.indexOf('await openBot(item.botId);');
    const body = src.slice(src.indexOf('} catch {', open), src.indexOf(RESCUE));
    const pushed = body.indexOf('offlineQueueRef.current.push(item);');
    const settled = body.indexOf(CLEAR);

    expect(open).toBeGreaterThan(-1);
    expect(pushed).toBeGreaterThan(-1);
    expect(body).toContain('persistOfflineQueue();');
    expect(body).toContain('continue;');
    // Put back first, then settled: the batch-wide rescue below cannot hand the
    // same row to the queue a second time.
    expect(settled).toBeGreaterThan(pushed);
  });
});

describe('the send path hands a destination to the queue', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');

  test('the not-connected guard queues the line with the destination its caller named', () => {
    const src = between(
      provider(),
      "if (!fromQueue && (!activeGateway || !client || status !== 'connected')) {",
      'if (!isSlashCommandInput(trimmed)',
    );

    // The trimmed words are what is parked, and the notice's destination rides
    // with them; a send from the composer names none and is queued as before.
    expect(src).toContain('queueOfflineInput(trimmed, { botId: options?.botId, sessionId: options?.sessionId });');
  });

  test('the row is written with the destination it was handed', () => {
    const src = between(provider(), 'const queueOfflineInput = useCallback', 'const updateLocalMessage');

    expect(src).toContain('(text: string, destination?: OfflineQueueDestination)');
    expect(src).toContain(
      'offlineQueueRef.current.push({ id, text, gatewayId, createdAt: Date.now(), ...destination });',
    );
  });
});

describe('the durable copy holds the batch a flush still owes', () => {
  test('the copy is the queue plus every row the flush has not settled', () => {
    const queue = [row({ id: 'later' })];
    const owed = [row({ id: 'in-flight' }), row({ id: 'in-flight-2' })];

    // The queue's own rows keep their order and the rows a flush still owes
    // follow them, so a kill mid-flush re-flushes exactly those rows.
    expect(durableQueueRows(queue, owed)).toEqual([...queue, ...owed]);
    // The flush holds its batch in a Set, and that is what the copy is composed
    // from — the caller does not build a second list to keep in step.
    expect(durableQueueRows(queue, new Set(owed))).toEqual([...queue, ...owed]);
  });

  test('a row that is on the queue and still owed is written once', () => {
    const putBack = row({ id: 'a' });

    // The flush's own Bot-open put-back can leave a row on the queue while the
    // flush still lists it as owed: the operator's line must not be written
    // twice over that bookkeeping order.
    expect(durableQueueRows([putBack], [putBack])).toEqual([putBack]);
  });

  test('nothing owed copies the queue itself, so an idle write is what it always was', () => {
    const queue = [row({ id: 'a' }), row({ id: 'b' })];

    const copy = durableQueueRows(queue, []);

    expect(copy).toEqual(queue);
    expect(copy).toHaveLength(2);
  });

  test('a queue a flush has emptied still keeps the rows it owes', () => {
    const owed = row({ id: 'only' });

    expect(durableQueueRows([], [owed])).toEqual([owed]);
  });
});

describe('a batch the flush is holding stays on disk until each row settles', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
  const CLEAR = 'unsent.delete(item);';
  const PACK = 'persistOfflineQueue();';
  const RELEASE = 'flushingOfflineRef.current = false;';
  const SEND = 'await sendChatInput(item.text, { fromQueue: true, messageId: item.id });';

  /** The batch: from the queue split to the moment the flush is released. */
  const flush = () =>
    between(provider(), '// Only flush items destined for the active gateway.', RELEASE);

  test('the batch is registered as still owed before the queue is trimmed', () => {
    const src = flush();
    const owed = src.indexOf('flushingOwedRef.current = unsent;');
    const split = src.indexOf('offlineQueueRef.current = remainder;');
    const packed = src.indexOf(PACK, split);

    expect(src).toContain('const unsent = new Set(forActive);');
    expect(owed).toBeGreaterThan(-1);
    // The batch leaves the queue, not the copy on disk: the owed set is in
    // place before the queue is trimmed and before the write that follows it.
    expect(split).toBeGreaterThan(owed);
    expect(packed).toBeGreaterThan(split);
  });

  test('the one write path packs the queue together with what the flush owes', () => {
    const src = between(
      provider(),
      'const persistOfflineQueue = useCallback',
      'const patchActivityRuns',
    );

    expect(src).toContain(
      'durableQueueRows(offlineQueueRef.current, flushingOwedRef.current ?? [])',
    );
    expect(src).toContain('saveOfflineQueue(');
  });

  test('a send that returns clears its row from the queue and from the durable copy', () => {
    const tail = between(flush(), SEND, '} catch {');

    expect(tail).toContain(CLEAR);
    expect(tail.indexOf(PACK)).toBeGreaterThan(tail.indexOf(CLEAR));
  });

  test('the Bot-open put-back settles its row on disk too, and the queue still holds it', () => {
    const body = between(flush(), 'offlineQueueRef.current.push(item);', 'continue;');

    expect(body).toContain(CLEAR);
    expect(body).toContain(PACK);
  });

  test('the flush releases the copy when it ends, so a later write is the queue alone', () => {
    const after = between(provider(), RELEASE, '})();');

    expect(after).toContain('flushingOwedRef.current = null;');
  });
});

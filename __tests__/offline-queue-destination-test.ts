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

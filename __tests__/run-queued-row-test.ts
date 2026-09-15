// An offline `/run` line queues as a run-shaped outbox row, and the reconnect
// flush re-sends it through the run dispatch so the result arrives through the
// notification path that already ships (FUTURE-ITEMS.md §D8 slice 1). A run
// typed against a down gateway is not an error reply and not ordinary chat —
// the row carries the run's own shape, and only a flush send moves it.

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
  isRunQueuedRow,
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

/** The row as a run line writes it — the run shape is what makes it a run. */
function row(overrides: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: 'item-1',
    text: '/run sweep the garage',
    gatewayId: 'gw-1',
    createdAt: 1757400000000,
    run: { bot: 'scout' },
    ...overrides,
  } as OfflineQueueItem;
}

const OFFLINE_QUEUE_KEY = 'versutus:offline-queue';

describe('the outbox row can be run-shaped, not chat-text-only', () => {
  test('a run row writes its prompt with the run shape and reads back intact', async () => {
    mockStore.clear();
    const item: OfflineQueueItem = {
      id: 'run-1',
      text: '/run sweep the garage',
      gatewayId: 'gw-1',
      createdAt: 7,
      run: { bot: 'scout' },
    };

    await saveOfflineQueue([item]);

    expect(await loadOfflineQueue()).toEqual([item]);
  });

  test('a composer line written before this field existed loads with no run shape — not an empty one the row could misread', async () => {
    mockStore.clear();
    const chat: OfflineQueueItem = {
      id: 'chat-1',
      text: 'just a reply',
      gatewayId: 'gw-1',
      createdAt: 1,
    };

    await saveOfflineQueue([chat]);
    const [loaded] = await loadOfflineQueue();

    expect(loaded).toEqual(chat);
    // The shape is optional and ABSENT on a chat line, never a placeholder
    // object a reader could mistake for a queued run.
    expect(Object.keys(loaded)).not.toContain('run');
  });

  test('a stored payload the run shape cannot read still loads — the shape is dropped, the words kept', async () => {
    mockStore.set(
      OFFLINE_QUEUE_KEY,
      JSON.stringify([
        { id: 'a', text: 'one', gatewayId: 'gw-1', createdAt: 1, run: 'yes' },
        {
          id: 'b',
          text: 'two',
          gatewayId: 'gw-1',
          createdAt: 2,
          run: { bot: 7 },
        },
        {
          id: 'c',
          text: 'three',
          gatewayId: 'gw-1',
          createdAt: 3,
          run: { bot: 'scout' },
        },
      ]),
    );

    const loaded = await loadOfflineQueue();

    expect(loaded.map((item) => item.text)).toEqual(['one', 'two', 'three']);
    // A non-object shape is not a fact this row carries at all.
    expect(loaded[0].run).toBeUndefined();
    // A shape whose Bot is not a present string keeps the RUN but drops the
    // field: the run is real, the Bot is what is unusable — the same rule a
    // destination's own id follows, and the flush starts the run unscoped.
    expect(loaded[1].run).toEqual({});
    expect(loaded[2].run).toEqual({ bot: 'scout' });
  });
});

describe('isRunQueuedRow reads the shape back', () => {
  test('a run row is a run row, and a chat line is not', () => {
    const runRow: OfflineQueueItem = row();
    const chatRow: OfflineQueueItem = {
      id: 'chat-1',
      text: 'hello',
      gatewayId: 'gw-1',
      createdAt: 1,
    };

    expect(isRunQueuedRow(runRow)).toBe(true);
    expect(isRunQueuedRow(chatRow)).toBe(false);
    // Never by content sniffing: a chat line that happens to start with /run
    // was still a composer line, and stays one.
    const chatThatLooksLikeRun: OfflineQueueItem = {
      id: 'chat-2',
      text: '/run sweep the garage',
      gatewayId: 'gw-1',
      createdAt: 2,
    };
    expect(isRunQueuedRow(chatThatLooksLikeRun)).toBe(false);
  });
});

describe('the flush re-sends a run-shaped row through the run dispatch, not the chat one', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
  const CHAT_SEND =
    'await sendChatInput(item.text, { fromQueue: true, messageId: item.id });';

  /** The flush's loop, from the queue split to the moment the flush is released. */
  const flush = () =>
    between(
      provider(),
      '// Only flush items destined for the active gateway.',
      'flushingOfflineRef.current = false;',
    );

  test("a run row takes the run branch BEFORE the chat send, and its Bot rides along", () => {
    const src = flush();
    const guard = src.indexOf('if (isRunQueuedRow(item)) {');
    const runSend = src.indexOf('await sendRunQueued(item.text, item.id, item.run);');
    const chatSend = src.indexOf(CHAT_SEND);

    expect(guard).toBeGreaterThan(-1);
    expect(runSend).toBeGreaterThan(guard);
    // The two sends are distinct paths: a run row never rides the chat branch.
    expect(chatSend).toBeGreaterThan(-1);
    expect(chatSend).toBeGreaterThan(runSend);
  });

  test('a run typed in a Bot Chat opens that Bot before it runs, and stays queued when the Bot will not open', () => {
    const src = flush();

    // Reply rows and run rows share one open-or-put-back guard, so a queued run
    // starts under the Bot it was typed for, never whichever Bot is selected
    // when the connection returns.
    expect(src).toContain(
      'const botToOpen = item.botId ?? (isRunQueuedRow(item) ? item.run?.bot : undefined);',
    );
    const open = src.indexOf('opened = await openBot(botToOpen);');
    const putBack = src.indexOf('offlineQueueRef.current.push(item);');
    const runSend = src.indexOf('await sendRunQueued(item.text, item.id, item.run);');
    expect(open).toBeGreaterThan(-1);
    expect(putBack).toBeGreaterThan(open);
    expect(runSend).toBeGreaterThan(putBack);
    // The run no longer throws its Bot away.
    expect(provider()).not.toContain('void run;');
  });

  test('the run branch carries the destination and no second pipeline exists', () => {
    const src = flush();

    // One chat send in the loop, still the shape the destination tests pin.
    expect(src.split(CHAT_SEND).length - 1).toBe(1);
    // The run row rides its own fold, with the shape handed through.
    expect(src).toContain('sendRunQueued(item.text, item.id, item.run)');
    // No second pipeline of its own: the run rides runTask inside the fold.
    expect(src).not.toContain('executeRun(');
    expect(src).not.toContain('fetch(');
  });

  test('the effect is keyed on the dispatch it needs, and the send carries a run field not a new seam', () => {
    const providerSrc = provider();

    expect(providerSrc).toContain(
      '}, [isCommandRunning, isSending, openBot, persistOfflineQueue, requestSurface, sendChatInput, sendRunQueued, status]);',
    );
    // The flush names the fold it needs.
    expect(providerSrc).toContain('if (isRunQueuedRow(item)) {');
  });

  test('the not-connected guard queues the line exactly as before — the run shape rides the text', () => {
    const src = between(
      provider(),
      "if (!fromQueue && (!activeGateway || !client || status !== 'connected')) {",
      'if (!isSlashCommandInput(trimmed)',
    );

    expect(src).toContain(
      'queueOfflineInput(trimmed, { botId: options?.botId, sessionId: options?.sessionId });',
    );
  });
});

describe('durableQueueRows still holds a run row the flush owes', () => {
  test('the copy is the queue plus every row the flush has not settled, run rows included', () => {
    const queue = [row({ id: 'later' })];
    const owed = [row({ id: 'in-flight' })];

    expect(durableQueueRows(queue, owed)).toEqual([...queue, ...owed]);
    expect(durableQueueRows([], [owed[0]])).toEqual([owed[0]]);
  });
});

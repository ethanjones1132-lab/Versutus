// VS-094, slice 4: the write seam at the end of a turn.
//
// Every case is fixture-only: the adapter is a Map, the journal meta is a
// fixture, and no network, device or Gate process is touched. The assertions
// are about the bytes the store would actually persist and about what a
// finished turn leaves behind for the row that mounts later.
//
// Before this slice nothing wrote a record when a turn finished, so every test
// here fails against the old code.

import type { ChatMessage } from '@/lib/gateway/types';
import type { TurnJournalRecord } from '@/lib/chat/turn-change-collector';
import { captureTurnChange } from '@/lib/chat/turn-change-capture';
import { resolveTurnChangeRowState } from '@/lib/chat/turn-change-row-state';
import {
  TURN_CHANGE_INDEX_KEY,
  TURN_CHANGE_RECORD_PREFIX,
  createTurnChangeStore,
  turnChangeRecordKey,
  type TurnChangeStorage,
} from '@/lib/chat/turn-change-store';
import { toTurnChangeSummary, type TurnChangeRecord } from '@/lib/chat/turn-changes';

type MemoryStorage = TurnChangeStorage & { data: Map<string, string> };

function memoryStorage(): MemoryStorage {
  const data = new Map<string, string>();
  return {
    data,
    async getItem(key: string): Promise<string | null> {
      return data.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      data.set(key, value);
    },
    async removeItem(key: string): Promise<void> {
      data.delete(key);
    },
    async getAllKeys(): Promise<string[]> {
      return [...data.keys()];
    },
  };
}

function journal(overrides: Partial<TurnJournalRecord> = {}): TurnJournalRecord {
  return {
    turnId: 'turn-write',
    sessionId: 'session-1',
    backendId: 'claude',
    status: 'done',
    startedAt: 1000,
    updatedAt: 1500,
    finishedAt: 2000,
    ...overrides,
  };
}

function message(
  turnId: string,
  timestamp: number,
  toolCalls: NonNullable<ChatMessage['toolCalls']>,
): ChatMessage {
  return {
    id: `bubble-${turnId}`,
    role: 'assistant',
    text: '',
    turnId,
    timestamp,
    toolCalls,
  };
}

function writeMessage(turnId: string): ChatMessage {
  return message(turnId, 1200, [
    {
      id: 'call-write',
      name: 'Write',
      detail: JSON.stringify({ file_path: 'src/a.ts', content: 'SECRET CONTENT' }),
    },
  ]);
}

describe('captureTurnChange — a finished turn', () => {
  test('a streamed Write persists its path and never its arguments', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({ storage, now: () => 10_000 });
    const messages = [writeMessage('turn-write')];

    const saved = await captureTurnChange({
      turnId: 'turn-write',
      sessionId: 'session-1',
      backendId: 'claude',
      turnMessages: messages,
      journalMeta: journal(),
      store,
    });

    expect(saved).not.toBeNull();
    if (!saved) return;
    expect(saved.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(saved.files[0]).toEqual({
      path: 'src/a.ts',
      status: 'unknown',
      evidence: 'tool',
      callIds: ['call-write'],
    });
    // The row a later mount reads is the persisted one, not the in-memory one.
    expect(await store.load('turn-write')).toEqual(saved);

    const persisted = [...storage.data.values()].join('\n');
    expect(persisted).not.toContain('SECRET');
    expect(persisted).not.toMatch(/"(content|detail|patch)":/);
  });

  test('finishing the same turn twice leaves one record for its turnId', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({ storage, now: () => 10_000 });
    const input = {
      turnId: 'turn-idem',
      sessionId: 'session-1',
      backendId: 'claude',
      turnMessages: [writeMessage('turn-idem')],
      journalMeta: journal({ turnId: 'turn-idem' }),
      store,
    };

    const first = await captureTurnChange(input);
    const second = await captureTurnChange(input);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    const recordKeys = [...storage.data.keys()].filter((key) =>
      key.startsWith(TURN_CHANGE_RECORD_PREFIX),
    );
    expect(recordKeys).toEqual([turnChangeRecordKey('turn-idem')]);

    const index = JSON.parse(storage.data.get(TURN_CHANGE_INDEX_KEY) ?? '[]') as Array<{
      turnId: string;
    }>;
    expect(index.filter((entry) => entry.turnId === 'turn-idem')).toHaveLength(1);

    const loaded = await store.load('turn-idem');
    expect(loaded?.turnId).toBe('turn-idem');
    expect(loaded?.files.map((file) => file.path)).toEqual(['src/a.ts']);
  });

  test('a Read and a Grep only still persist an empty record, and show no row', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({ storage, now: () => 10_000 });
    const messages = [
      message('turn-read', 1200, [
        { id: 'call-read', name: 'Read', detail: JSON.stringify({ file_path: 'src/a.ts' }) },
        { id: 'call-grep', name: 'Grep', detail: JSON.stringify({ pattern: 'needle' }) },
      ]),
    ];

    const saved = await captureTurnChange({
      turnId: 'turn-read',
      sessionId: 'session-1',
      backendId: 'claude',
      turnMessages: messages,
      journalMeta: journal({ turnId: 'turn-read' }),
      store,
    });

    expect(saved).not.toBeNull();
    if (!saved) return;
    expect(saved.files).toEqual([]);
    // Stored, not a miss: a later mount can answer "nothing changed" instead of
    // "unavailable". The row itself renders nothing for an empty record.
    expect(await store.load('turn-read')).toEqual(saved);
    expect(toTurnChangeSummary(saved)).toBeNull();

    const state = await resolveTurnChangeRowState({
      turnId: 'turn-read',
      streaming: false,
      store,
    });
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.record.files).toEqual([]);
    expect(toTurnChangeSummary(state.record)).toBeNull();
  });

  test('a turn with no turn id writes nothing and never touches the store', async () => {
    const save = jest.fn(async (record: TurnChangeRecord) => record);
    const store = { save };

    const saved = await captureTurnChange({
      turnId: undefined,
      sessionId: 'session-1',
      backendId: 'claude',
      turnMessages: [writeMessage('turn-nobody')],
      journalMeta: journal({ turnId: 'turn-nobody' }),
      store,
    });

    expect(saved).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  test('a rejected save leaves the transcript unchanged and the finish path resolved', async () => {
    const messages = [writeMessage('turn-refused')];
    const before = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
    const save = jest.fn(async (_record: TurnChangeRecord) => {
      throw new Error('storage refused');
    });
    const store = { save };
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      captureTurnChange({
        turnId: 'turn-refused',
        sessionId: 'session-1',
        backendId: 'claude',
        turnMessages: messages,
        journalMeta: journal({ turnId: 'turn-refused' }),
        store,
      }),
    ).resolves.toBeNull();

    expect(save).toHaveBeenCalledTimes(1);
    // The turn's own bubbles are untouched, so the transcript is unchanged.
    expect(messages).toEqual(before);
    // Nothing is logged that could carry the Write's arguments.
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining('SECRET'));
    logged.mockRestore();
  });
});

describe('captureTurnChange — a turn that did not finish', () => {
  test('an interrupted turn with a write-like call persists what it streamed', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({ storage, now: () => 10_000 });

    const saved = await captureTurnChange({
      turnId: 'turn-partial',
      sessionId: 'session-1',
      backendId: 'claude',
      turnMessages: [writeMessage('turn-partial')],
      journalMeta: journal({ turnId: 'turn-partial', status: 'interrupted' }),
      outcome: 'interrupted',
      store,
    });

    expect(saved?.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(await store.load('turn-partial')).toEqual(saved);
  });

  test('an interrupted turn with no evidence writes nothing', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({ storage, now: () => 10_000 });
    const messages = [
      message('turn-quiet', 1200, [
        { id: 'call-read', name: 'Read', detail: JSON.stringify({ file_path: 'src/a.ts' }) },
      ]),
    ];

    const saved = await captureTurnChange({
      turnId: 'turn-quiet',
      sessionId: 'session-1',
      backendId: 'claude',
      turnMessages: messages,
      journalMeta: journal({ turnId: 'turn-quiet', status: 'interrupted' }),
      outcome: 'interrupted',
      store,
    });

    expect(saved).toBeNull();
    expect(storage.data.has(turnChangeRecordKey('turn-quiet'))).toBe(false);
    expect(await store.load('turn-quiet')).toBeNull();
  });
});

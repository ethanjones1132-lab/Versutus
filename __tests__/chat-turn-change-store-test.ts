// VS-094, slice 2: the local record store.
//
// The adapter is a Map, the clock is injected, and every assertion is made on
// the bytes the store would actually persist. No network, no device, no Gate.

import type { TurnChangeFile, TurnChangeRecord } from '@/lib/chat/turn-changes';
import {
  TURN_CHANGE_MAX_TURNS,
  TURN_CHANGE_TTL_MS,
  createTurnChangeStore,
  turnChangeRecordKey,
} from '@/lib/chat/turn-change-store';
import type { TurnChangeStorage } from '@/lib/chat/turn-change-store';

function memoryStorage(initial: Record<string, string> = {}): TurnChangeStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
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

function makeFile(path: string, overrides: Partial<TurnChangeFile> = {}): TurnChangeFile {
  return { path, status: 'modified', evidence: 'diff', callIds: [], ...overrides };
}

function makeRecord(overrides: Partial<TurnChangeRecord> = {}): TurnChangeRecord {
  return {
    v: 1,
    turnId: 'turn-1',
    sessionId: 'session-1',
    backendId: 'opencode',
    startedAt: 1000,
    endedAt: 2000,
    files: [makeFile('src/a.ts', { additions: 4, deletions: 1, callIds: ['c1'] })],
    truncated: false,
    omitted: 0,
    ...overrides,
  };
}

describe('turn change store', () => {
  test('round trips a record under its turnId and answers null for a missing turn', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({ storage, now: () => 10_000 });

    const saved = await store.save(makeRecord({ turnId: 'turn-a' }));

    expect(await store.load('turn-a')).toEqual(saved);
    expect(await store.load('turn-missing')).toBeNull();
  });

  test('keys records on turnId so two turns never share a row', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({ storage, now: () => 10_000 });

    await store.save(makeRecord({ turnId: 'turn-a', files: [makeFile('src/a.ts')] }));
    await store.save(makeRecord({ turnId: 'turn-b', files: [makeFile('src/b.ts')] }));

    const a = await store.load('turn-a');
    const b = await store.load('turn-b');
    expect(a?.turnId).toBe('turn-a');
    expect(a?.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(b?.turnId).toBe('turn-b');
    expect(b?.files.map((file) => file.path)).toEqual(['src/b.ts']);
  });

  test('a corrupt or wrong-turn stored record degrades to null', async () => {
    const storage = memoryStorage({
      [turnChangeRecordKey('turn-corrupt')]: '{"v":1,',
    });
    const other = makeRecord({ turnId: 'turn-elsewhere' });
    storage.data.set(turnChangeRecordKey('turn-wrong'), JSON.stringify(other));
    const store = createTurnChangeStore({ storage, now: () => 10_000 });

    expect(await store.load('turn-corrupt')).toBeNull();
    // The key says one turn, the payload says another: refuse it.
    expect(await store.load('turn-wrong')).toBeNull();
  });

  test('the stored JSON never carries content, patch, detail or output', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({ storage, now: () => 10_000 });
    const dirty = {
      ...makeRecord(),
      content: 'SECRET CONTENT',
      files: [
        {
          ...makeFile('src/a.ts', { additions: 2, deletions: 1, callIds: ['c1'] }),
          patch: 'SECRET PATCH',
          detail: 'SECRET DETAIL',
          output: 'SECRET OUTPUT',
        },
      ],
    } as unknown as TurnChangeRecord;

    const saved = await store.save(dirty);

    const persisted = [...storage.data.values()].join('\n');
    expect(persisted).not.toContain('SECRET');
    expect(persisted).not.toMatch(/"(content|patch|detail|output)":/);

    const loaded = await store.load('turn-1');
    expect(loaded).toEqual(saved);
    expect(Object.keys(loaded ?? {}).sort()).toEqual([
      'backendId',
      'endedAt',
      'files',
      'omitted',
      'sessionId',
      'startedAt',
      'truncated',
      'turnId',
      'v',
    ]);
  });

  test('save applies the landed caps before persisting', async () => {
    const storage = memoryStorage();
    const store = createTurnChangeStore({
      storage,
      now: () => 10_000,
      caps: { maxPaths: 2 },
    });
    const files = Array.from({ length: 5 }, (_, index) => makeFile(`src/f${index}.ts`));

    const saved = await store.save(makeRecord({ files }));

    expect(saved.files).toHaveLength(2);
    expect(saved.truncated).toBe(true);
    expect(saved.omitted).toBe(3);
    const loaded = await store.load('turn-1');
    expect(loaded?.files).toHaveLength(2);
    expect(loaded?.omitted).toBe(3);
  });

  test('a record past the 7-day horizon reads as unavailable', async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const store = createTurnChangeStore({ storage, now: () => now });
    await store.save(makeRecord({ turnId: 'old', endedAt: now }));

    now += TURN_CHANGE_TTL_MS + 1;

    expect(await store.load('old')).toBeNull();
    expect(storage.data.has(turnChangeRecordKey('old'))).toBe(false);
  });

  test('more than maxTurns records evicts the least recently used', async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const store = createTurnChangeStore({ storage, now: () => now, maxTurns: 2 });

    await store.save(makeRecord({ turnId: 'turn-1', endedAt: now }));
    now += 1000;
    await store.save(makeRecord({ turnId: 'turn-2', endedAt: now }));

    // Reading turn-1 makes turn-2 the least recently used, even though turn-1
    // was written first. A FIFO cap would evict the wrong one here.
    now += 1000;
    expect(await store.load('turn-1')).not.toBeNull();
    now += 1000;
    await store.save(makeRecord({ turnId: 'turn-3', endedAt: now }));

    expect(await store.load('turn-1')).not.toBeNull();
    expect(await store.load('turn-2')).toBeNull();
    expect(await store.load('turn-3')).not.toBeNull();
  });

  test('the horizon constants are the design caps', () => {
    expect(TURN_CHANGE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(TURN_CHANGE_MAX_TURNS).toBe(300);
  });
});

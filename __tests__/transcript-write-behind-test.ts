// `updateTranscript` runs on every streamed `/agent` delta (the provider's
// `updateLocalMessage`, driven by `onAgentDelta`), and it is a read-modify-write
// over one AsyncStorage key. Two things follow, and both are pinned here:
// unserialized, overlapping updates each build their list from the same
// snapshot and the later write erases the earlier one's summary; and written
// through, the I/O rate is the token rate.
//
// So the writes are queued per key and written behind, and the held copy is
// what a read sees — a delta the operator is watching must not vanish because
// the write behind it has not landed yet.

const mockBacking = new Map<string, string>();
const mockGet = jest.fn(async (key: string) => mockBacking.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => {
  mockBacking.set(key, value);
});
const mockRemove = jest.fn(async (key: string) => {
  mockBacking.delete(key);
});
const mockGetAllKeys = jest.fn(async () => [...mockBacking.keys()]);
const mockMultiRemove = jest.fn(async (keys: string[]) => {
  for (const key of keys) mockBacking.delete(key);
});

// Lazy wrappers, not the jest.fn()s themselves: a registry reset (the restart
// case below) re-runs this factory, and the implementations have to survive it.
jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: (key: string) => mockGet(key),
    setItem: (key: string, value: string) => mockSet(key, value),
    removeItem: (key: string) => mockRemove(key),
    getAllKeys: () => mockGetAllKeys(),
    multiRemove: (keys: string[]) => mockMultiRemove(keys),
  },
}));

import {
  appendTranscript,
  clearTranscriptsForGateway,
  createTranscriptId,
  flushTranscripts,
  loadTranscripts,
  saveTranscripts,
  updateTranscript,
} from '@/lib/gateway/transcript';
import type { CommandTranscriptEntry } from '@/lib/gateway/types';

/** The module's own key rule, spelled out: `transcriptKey` is not exported. */
const storageKey = (gatewayId: string, sessionKey: string) =>
  `versutus:transcript:${gatewayId}:${sessionKey}`;

/** Comfortably past the write-behind's 250 ms, for "no write arrives late". */
const AFTER_THE_DEBOUNCE_MS = 400;

let unique = 0;
/** A gateway nobody else in this file uses, so the held copies stay apart. */
const freshGateway = () => `gw-${(unique += 1)}`;

function entry(overrides: Partial<CommandTranscriptEntry> = {}): CommandTranscriptEntry {
  return {
    id: createTranscriptId(),
    gatewayId: 'gw',
    sessionKey: 'session',
    input: '/status',
    title: 'status',
    status: 'complete',
    summary: 'ok',
    createdAt: 1,
    ...overrides,
  };
}

const stored = (gatewayId: string, sessionKey: string): CommandTranscriptEntry[] => {
  const raw = mockBacking.get(storageKey(gatewayId, sessionKey));
  return raw ? (JSON.parse(raw) as CommandTranscriptEntry[]) : [];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  mockBacking.clear();
  mockSet.mockClear();
  mockRemove.mockClear();
  mockMultiRemove.mockClear();
});

describe('transcript write-behind', () => {
  test('fifty concurrent updates to one entry all survive', async () => {
    const gatewayId = freshGateway();
    const seeded = entry({ id: 'cmd-1', gatewayId, sessionKey: 'session' });
    await appendTranscript(gatewayId, 'session', seeded);

    // The shape the provider produces: one update per delta, each carrying the
    // full streamed text so far. Unserialized, every update builds its list from
    // the same snapshot and only the last one to write survives, so the fields
    // the other 49 patched are back to what was seeded.
    const fields = ['input', 'title', 'summary', 'raw', 'runId', 'sessionId'] as const;
    const patches = Array.from({ length: 50 }, (_, i) => {
      const field = fields[i % fields.length];
      return { [field]: `${field}-${i}` } as Partial<CommandTranscriptEntry>;
    });
    // Applied in call order, so the last patch to a field is the one held.
    const expected = patches.reduce<Partial<CommandTranscriptEntry>>(
      (acc, patch) => ({ ...acc, ...patch }),
      {},
    );

    const results = await Promise.all(
      patches.map((patch) => updateTranscript(gatewayId, 'session', 'cmd-1', patch)),
    );
    const held = results[results.length - 1];

    expect(held).toHaveLength(1);
    expect(held[0]).toEqual({ ...seeded, ...expected });

    await flushTranscripts();

    expect(stored(gatewayId, 'session')).toEqual(held);
  });

  test('a burst of a hundred updates in one tick costs a handful of writes', async () => {
    const gatewayId = freshGateway();
    await appendTranscript(gatewayId, 'session', entry({ id: 'cmd-1', gatewayId }));

    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        updateTranscript(gatewayId, 'session', 'cmd-1', { summary: `delta ${i}` }),
      ),
    );

    // Nothing has been written yet: the whole burst is one pending write.
    expect(mockSet).not.toHaveBeenCalled();
    expect((await loadTranscripts(gatewayId, 'session'))[0].summary).toBe('delta 99');

    await flushTranscripts();

    expect(mockSet.mock.calls.length).toBeLessThanOrEqual(3);
    expect(stored(gatewayId, 'session')[0].summary).toBe('delta 99');
  });

  test('a read sees an update that is still queued, and the store catches up', async () => {
    const gatewayId = freshGateway();
    const seeded = entry({ id: 'cmd-1', gatewayId });
    await appendTranscript(gatewayId, 'session', seeded);
    mockSet.mockClear();

    await updateTranscript(gatewayId, 'session', 'cmd-1', { summary: 'mid-stream' });

    expect((await loadTranscripts(gatewayId, 'session'))[0].summary).toBe('mid-stream');
    expect(mockSet).not.toHaveBeenCalled();

    await flushTranscripts();
    expect(stored(gatewayId, 'session')[0].summary).toBe('mid-stream');
  });

  test('a whole-list save writes through immediately', async () => {
    const gatewayId = freshGateway();
    const list = [entry({ id: 'cmd-1' }), entry({ id: 'cmd-2' })];

    await saveTranscripts(gatewayId, 'session', list);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(stored(gatewayId, 'session')).toEqual(list);
  });

  test('the list stays bounded to the newest 200 entries', async () => {
    const gatewayId = freshGateway();
    await saveTranscripts(
      gatewayId,
      'session',
      Array.from({ length: 210 }, (_, i) => entry({ id: `cmd-${i}` })),
    );

    const held = await loadTranscripts(gatewayId, 'session');
    expect(held).toHaveLength(200);
    expect(held[0].id).toBe('cmd-10');
    expect(stored(gatewayId, 'session')).toHaveLength(200);
  });

  test('a refused write is reported and does not strand later updates', async () => {
    const gatewayId = freshGateway();
    const first = entry({ id: 'cmd-1', gatewayId });
    const second = entry({ id: 'cmd-2', gatewayId });
    await appendTranscript(gatewayId, 'session', first);

    mockSet.mockImplementationOnce(async () => {
      throw new Error('row too big');
    });

    // The failure has no caller to reject to until the flush forces it, and it
    // is reported there rather than swallowed.
    await expect(flushTranscripts()).rejects.toThrow('row too big');

    await appendTranscript(gatewayId, 'session', second);
    await flushTranscripts();

    expect(stored(gatewayId, 'session')).toEqual([first, second]);
  });
});

describe('clearing a gateway', () => {
  test('drops the held copy and the write that was still pending', async () => {
    const gatewayId = freshGateway();
    const key = storageKey(gatewayId, 'session');
    await appendTranscript(gatewayId, 'session', entry({ id: 'cmd-1', gatewayId }));

    await clearTranscriptsForGateway(gatewayId);
    expect(mockBacking.has(key)).toBe(false);
    expect(await loadTranscripts(gatewayId, 'session')).toEqual([]);

    // A timer armed by the last delta would put the transcript back seconds
    // after the profile it belonged to is gone.
    mockSet.mockClear();
    await flushTranscripts();
    await sleep(AFTER_THE_DEBOUNCE_MS);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockBacking.has(key)).toBe(false);
  });
});

describe('a transcript that outlives the process', () => {
  test('a flushed value is what a fresh module load reads', async () => {
    const gatewayId = freshGateway();
    const seeded = entry({ id: 'cmd-1', gatewayId });
    await appendTranscript(gatewayId, 'session', seeded);
    await updateTranscript(gatewayId, 'session', 'cmd-1', { summary: 'done' });
    await flushTranscripts();

    jest.resetModules();
    const restarted = jest.requireActual<typeof import('@/lib/gateway/transcript')>(
      '@/lib/gateway/transcript',
    );

    expect(await restarted.loadTranscripts(gatewayId, 'session')).toEqual([
      { ...seeded, summary: 'done' },
    ]);
  });
});

describe('a store that will not hand the key over', () => {
  test('a throwing read is an empty transcript, and it says so', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockImplementationOnce(async () => {
      throw new Error('SQLite disk image is malformed');
    });

    await expect(loadTranscripts('gw-refused', 'session')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('SQLite disk image is malformed');

    warn.mockRestore();
  });
});

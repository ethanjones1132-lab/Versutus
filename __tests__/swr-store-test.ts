// A cache that lies is worse than no cache. These pin the three properties the
// roster/session/model/history paints depend on: a copy round trips, a copy
// that cannot be trusted (corrupt, oversized, secret-bearing) never becomes
// one, and nothing in the store can throw into the read that consulted it.

const backing = new Map<string, string>();
const mockGet = jest.fn(async (key: string) => backing.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => {
  backing.set(key, value);
});
const mockRemove = jest.fn(async (key: string) => {
  backing.delete(key);
});
const mockGetAllKeys = jest.fn(async () => [...backing.keys()]);
const mockMultiRemove = jest.fn(async (keys: string[]) => {
  for (const key of keys) backing.delete(key);
});
/** Makes every storage call throw, to prove a cache failure is never a caller failure. */
let mockStorageBroken = false;

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: (key: string) => (mockStorageBroken ? Promise.reject(new Error('disk full')) : mockGet(key)),
    setItem: (key: string, value: string) =>
      mockStorageBroken ? Promise.reject(new Error('disk full')) : mockSet(key, value),
    removeItem: (key: string) => (mockStorageBroken ? Promise.reject(new Error('disk full')) : mockRemove(key)),
    getAllKeys: () => (mockStorageBroken ? Promise.reject(new Error('disk full')) : mockGetAllKeys()),
    multiRemove: (keys: string[]) =>
      mockStorageBroken ? Promise.reject(new Error('disk full')) : mockMultiRemove(keys),
  },
}));

type Store = typeof import('@/lib/cache/swr-store');

/**
 * A fresh store per test: its in-memory front is module state, so reusing one
 * instance would let a copy written by an earlier test answer this one.
 */
let store: Store;

beforeEach(() => {
  jest.resetModules();
  backing.clear();
  mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
  mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
    backing.set(key, value);
  });
  mockRemove.mockReset().mockImplementation(async (key: string) => {
    backing.delete(key);
  });
  mockGetAllKeys.mockReset().mockImplementation(async () => [...backing.keys()]);
  mockMultiRemove.mockReset().mockImplementation(async (keys: string[]) => {
    for (const key of keys) backing.delete(key);
  });
  mockStorageBroken = false;
  store = jest.requireActual<Store>('@/lib/cache/swr-store');
});

describe('the store key and round trip', () => {
  test('a copy comes back with the time it was written', async () => {
    await store.writeCached('roster', 'gw-1', 'bots', [{ id: 'a' }]);
    const cached = await store.readCached<{ id: string }[]>('roster', 'gw-1', 'bots');
    expect(cached?.value).toEqual([{ id: 'a' }]);
    expect(typeof cached?.savedAt).toBe('number');
    expect(cached!.savedAt).toBeGreaterThan(0);
  });

  test('the storage key names the namespace, gateway and key', async () => {
    await store.writeCached('models', 'gw-1', 'catalog', []);
    expect(store.swrCacheKey('models', 'gw-1', 'catalog')).toBe('versutus:swr:models:gw-1:catalog');
    expect(backing.has('versutus:swr:models:gw-1:catalog')).toBe(true);
    // The envelope carries its version and the write time.
    const stored = JSON.parse(backing.get('versutus:swr:models:gw-1:catalog') ?? '');
    expect(stored.v).toBe(1);
    expect(typeof stored.savedAt).toBe('number');
  });

  test('a key nobody wrote is a miss, not an error', async () => {
    await expect(store.readCached('roster', 'gw-1', 'bots')).resolves.toBeNull();
  });

  test("two gateways never see each other's copy", async () => {
    await store.writeCached('roster', 'gw-1', 'bots', ['one']);
    await expect(store.readCached('roster', 'gw-2', 'bots')).resolves.toBeNull();
  });
});

describe('a copy that cannot be trusted never becomes one', () => {
  test('corrupt JSON reads as a miss', async () => {
    backing.set('versutus:swr:roster:gw-1:bots', '{not json');
    await expect(store.readCached('roster', 'gw-1', 'bots')).resolves.toBeNull();
  });

  test('an envelope of the wrong shape reads as a miss', async () => {
    backing.set('versutus:swr:roster:gw-1:bots', JSON.stringify({ v: 2, savedAt: 1, value: [] }));
    await expect(store.readCached('roster', 'gw-1', 'bots')).resolves.toBeNull();
    backing.set('versutus:swr:roster:gw-2:bots', JSON.stringify({ v: 1, value: [] }));
    await expect(store.readCached('roster', 'gw-2', 'bots')).resolves.toBeNull();
    backing.set('versutus:swr:roster:gw-3:bots', JSON.stringify({ savedAt: 1, value: [] }));
    await expect(store.readCached('roster', 'gw-3', 'bots')).resolves.toBeNull();
    backing.set('versutus:swr:roster:gw-4:bots', JSON.stringify(['not', 'an', 'envelope']));
    await expect(store.readCached('roster', 'gw-4', 'bots')).resolves.toBeNull();
  });

  test('a storage read that throws reads as a miss', async () => {
    mockStorageBroken = true;
    await expect(store.readCached('roster', 'gw-1', 'bots')).resolves.toBeNull();
  });

  test('a storage write that throws does not reach the caller', async () => {
    mockStorageBroken = true;
    await expect(store.writeCached('roster', 'gw-1', 'bots', ['a'])).resolves.toBeUndefined();
    mockStorageBroken = false;
    // Nothing reached the disk, but the value this session just produced is
    // still the newest copy the app holds, so the memory front keeps it.
    expect(backing.has('versutus:swr:roster:gw-1:bots')).toBe(false);
    expect((await store.readCached('roster', 'gw-1', 'bots'))?.value).toEqual(['a']);
  });
});

describe('the size cap', () => {
  test('an oversized value is refused and the old copy is removed', async () => {
    await store.writeCached('roster', 'gw-1', 'bots', ['good']);
    expect(await store.readCached('roster', 'gw-1', 'bots')).toEqual({
      value: ['good'],
      savedAt: expect.any(Number),
    });

    await store.writeCached('roster', 'gw-1', 'bots', ['x'.repeat(store.SWR_MAX_BYTES)]);
    expect(backing.has('versutus:swr:roster:gw-1:bots')).toBe(false);
    // The in-memory front must not hand back the copy the disk just refused.
    await expect(store.readCached('roster', 'gw-1', 'bots')).resolves.toBeNull();
  });

  test('a value just under the cap is stored', async () => {
    const payload = ['y'.repeat(store.SWR_MAX_BYTES - 200)];
    await store.writeCached('history', 'gw-1', 'last40', payload);
    expect((await store.readCached<string[]>('history', 'gw-1', 'last40'))?.value).toEqual(payload);
  });
});

describe('writes are serialized per key', () => {
  afterEach(() => {
    mockSet.mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
  });

  test('two writes to one key land in order, newest last', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    mockSet.mockImplementation(async (key: string, value: string) => {
      order.push(value);
      if (!releaseFirst) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      backing.set(key, value);
    });

    const first = store.writeCached('roster', 'gw-1', 'bots', ['older']);
    const second = store.writeCached('roster', 'gw-1', 'bots', ['newer']);
    // Let both calls queue; the second must not have touched storage yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toHaveLength(1);
    expect(order[0]).toContain('"older"');
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toHaveLength(2);
    expect(order[1]).toContain('"newer"');
    expect(await store.readCached('roster', 'gw-1', 'bots')).toEqual({
      value: ['newer'],
      savedAt: expect.any(Number),
    });
  });

  test('a write that throws does not strand the next one behind it', async () => {
    mockSet.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.writeCached('roster', 'gw-1', 'bots', ['a'])).resolves.toBeUndefined();
    await store.writeCached('roster', 'gw-1', 'bots', ['b']);
    expect(await store.readCached('roster', 'gw-1', 'bots')).toEqual({
      value: ['b'],
      savedAt: expect.any(Number),
    });
  });
});

describe('nothing secret is ever written', () => {
  test('credential-shaped fields are recognised by word', () => {
    for (const name of ['token', 'api_key', 'listenKey', 'authToken', 'password', 'SECRET', 'apiKey']) {
      expect(store.isSecretFieldName(name)).toBe(true);
    }
    for (const name of ['monkey', 'id', 'displayName', 'hotkey', 'routingIssue', 'last_active']) {
      expect(store.isSecretFieldName(name)).toBe(false);
    }
  });

  test('the sweep reaches nested objects and arrays', () => {
    expect(
      store.stripSecretFields({
        id: 'gw',
        token: 'secret-value',
        nested: { listenKey: 'lk', models: [{ provider: 'kilo', api_key: 'ak' }] },
      }),
    ).toEqual({ id: 'gw', nested: { models: [{ provider: 'kilo' }] } });
  });

  test('a write carrying a credential stores without it', async () => {
    await store.writeCached('roster', 'gw-1', 'bots', [{ id: 'a', displayName: 'A', token: 'leak' }]);
    const cached = await store.readCached<Record<string, unknown>[]>('roster', 'gw-1', 'bots');
    expect(cached?.value).toEqual([{ id: 'a', displayName: 'A' }]);
    expect(backing.get('versutus:swr:roster:gw-1:bots')).not.toContain('leak');
  });
});

describe('clearing one gateway', () => {
  test('every namespace of that gateway goes, other gateways stay', async () => {
    await store.writeCached('roster', 'gw-1', 'bots', ['a']);
    await store.writeCached('sessions', 'gw-1:cfg:hermes', 'page1', ['s1']);
    await store.writeCached('models', 'gw-1:cfg:hermes', 'catalog', ['m1']);
    await store.writeCached('history', 'gw-1:s-7', 'last40', ['h1']);
    await store.writeCached('roster', 'gw-2', 'bots', ['other']);

    await store.clearCachedForGateway('gw-1');

    await expect(store.readCached('roster', 'gw-1', 'bots')).resolves.toBeNull();
    // A scoped cache id still starts with the gateway id it belongs to.
    await expect(store.readCached('sessions', 'gw-1:cfg:hermes', 'page1')).resolves.toBeNull();
    await expect(store.readCached('models', 'gw-1:cfg:hermes', 'catalog')).resolves.toBeNull();
    await expect(store.readCached('history', 'gw-1:s-7', 'last40')).resolves.toBeNull();
    expect((await store.readCached('roster', 'gw-2', 'bots'))?.value).toEqual(['other']);
  });

  test('a store that refuses the clear is not a thrown delete', async () => {
    mockStorageBroken = true;
    await expect(store.clearCachedForGateway('gw-1')).resolves.toBeUndefined();
  });
});

describe('the in-memory front', () => {
  test('a repeat read is served without touching storage again', async () => {
    await store.writeCached('roster', 'gw-1', 'bots', ['a']);
    mockGet.mockClear();
    await store.readCached('roster', 'gw-1', 'bots');
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('the in-memory front is bounded and drops the least recent entry', async () => {
    for (let index = 0; index < store.SWR_MEMORY_ENTRIES; index += 1) {
      await store.writeCached('history', 'gw-1', `last${index}`, [index]);
    }
    // Touch entry 0 so it is no longer the least recent.
    await store.readCached('history', 'gw-1', 'last0');
    await store.writeCached('history', 'gw-1', `last${store.SWR_MEMORY_ENTRIES}`, ['new']);

    // The disk still holds entry 1 — only the memory front is bounded.
    expect(backing.has('versutus:swr:history:gw-1:last1')).toBe(true);
    backing.delete('versutus:swr:history:gw-1:last1');
    await expect(store.readCached('history', 'gw-1', 'last1')).resolves.toBeNull();
    // Entry 0 was promoted, so it is still held.
    mockGet.mockClear();
    expect((await store.readCached('history', 'gw-1', 'last0'))?.value).toEqual([0]);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
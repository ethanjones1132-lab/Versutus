// Gateway profiles persist as one SecureStore item, so a blob that will not
// parse is the one failed read whose bytes are worth more than the empty list
// the load answers with: they hold every saved gateway and every token. It used
// to return `[]` and move on, and the next `upsertGateway` — which the operator
// reaches for precisely because nothing loaded — overwrote whatever it came
// from. So the raw string is parked under its own key first.
//
// It is parked in SecureStore, not in plaintext AsyncStorage: the same JSON
// carries `GatewayProfile.token` and the session key, and a parse failure says
// the store handed the value over perfectly well — only the contents are bad.
// SecureStore cannot list its keys, so the copies live in a fixed ring of three
// slots rather than a prefix that has to be pruned.

const mockSecure = new Map<string, string>();
const mockPlain = new Map<string, string>();

const mockSecureGet = jest.fn(async (key: string) => mockSecure.get(key) ?? null);
const mockSecureSet = jest.fn(async (key: string, value: string) => {
  mockSecure.set(key, value);
});
const mockSecureRemove = jest.fn(async (key: string) => {
  mockSecure.delete(key);
});
const mockPlainSet = jest.fn(async (key: string, value: string) => {
  mockPlain.set(key, value);
});
const mockPlainRemove = jest.fn(async (key: string) => {
  mockPlain.delete(key);
});
const mockPlainGetAllKeys = jest.fn(async () => [...mockPlain.keys()]);

jest.mock('@/lib/storage/secure-key-value', () => ({
  secureKeyValueStorage: {
    getItem: (key: string) => mockSecureGet(key),
    setItem: (key: string, value: string) => mockSecureSet(key, value),
    removeItem: (key: string) => mockSecureRemove(key),
  },
}));

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: async (key: string) => mockPlain.get(key) ?? null,
    setItem: (key: string, value: string) => mockPlainSet(key, value),
    removeItem: (key: string) => mockPlainRemove(key),
    getAllKeys: () => mockPlainGetAllKeys(),
    multiRemove: async (keys: string[]) => {
      for (const key of keys) mockPlain.delete(key);
    },
  },
}));

import { loadGateways, upsertGateway } from '@/lib/gateway/storage';
import type { GatewayProfile } from '@/lib/gateway/types';

const GATEWAYS_KEY = 'versutus:gateways';
const CORRUPT_PREFIX = 'versutus:gateways:corrupt-';
const CORRUPT_NEXT_KEY = 'versutus:gateways:corrupt-next';
const slotKey = (slot: number): string => `${CORRUPT_PREFIX}${slot}`;

const profile = (overrides: Partial<GatewayProfile> & Pick<GatewayProfile, 'id'>): GatewayProfile => ({
  name: 'Gate',
  url: 'http://127.0.0.1:8760',
  createdAt: 1,
  ...overrides,
});

/** The secure-store slots currently holding a rescue copy, by slot key. */
const corruptCopies = (): Map<string, string> =>
  new Map([...mockSecure].filter(([key]) => key.startsWith(CORRUPT_PREFIX) && key !== CORRUPT_NEXT_KEY));

describe('a gateways blob that will not parse', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSecure.clear();
    mockPlain.clear();
    mockPlainSet.mockClear();
    mockSecureGet.mockImplementation(async (key: string) => mockSecure.get(key) ?? null);
    mockSecureSet.mockImplementation(async (key: string, value: string) => {
      mockSecure.set(key, value);
    });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('is kept before it is read as none, and the operator is told where it went', async () => {
    const raw = '[{"id":"gw-1","token":"listen-hermes"';
    mockSecure.set(GATEWAYS_KEY, raw);

    await expect(loadGateways()).resolves.toEqual([]);

    const copies = corruptCopies();
    expect([...copies.values()]).toEqual([raw]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain([...copies.keys()][0]);
  });

  test('never reaches the plain store, which is where the tokens were audited out of', async () => {
    const raw = '[{"id":"gw-1","token":"listen-hermes"}';
    mockSecure.set(GATEWAYS_KEY, raw);

    await loadGateways();

    const plainKeysWritten = mockPlainSet.mock.calls.map(([key]) => String(key));
    expect(plainKeysWritten.filter((key) => key.startsWith(CORRUPT_PREFIX))).toEqual([]);
    expect([...mockPlain.values()]).not.toContain(raw);
    // It did go somewhere, and that somewhere is the secure store.
    expect([...corruptCopies().values()]).toEqual([raw]);
  });

  test('is kept for a value that parses but is not a list of profiles', async () => {
    const raw = '{"id":"gw-1"}';
    mockSecure.set(GATEWAYS_KEY, raw);

    await expect(loadGateways()).resolves.toEqual([]);

    expect([...corruptCopies().values()]).toEqual([raw]);
  });

  test('survives the upsert the operator reaches for next', async () => {
    const raw = '[{"id":"gw-1","token":"listen-hermes"';
    mockSecure.set(GATEWAYS_KEY, raw);
    await loadGateways();

    const gateways = await upsertGateway(profile({ id: 'gw-2', token: 'fresh' }));

    expect(gateways.map((item) => item.id)).toEqual(['gw-2']);
    expect([...corruptCopies().values()]).toContain(raw);
    // The rescued token is still somewhere to be recovered from.
    expect(mockSecure.get(GATEWAYS_KEY)).not.toBe(raw);
  });

  test('keeps the three newest copies and overwrites the rest of the ring', async () => {
    for (const attempt of ['one', 'two', 'three', 'four', 'five']) {
      mockSecure.set(GATEWAYS_KEY, `broken-${attempt}`);
      await loadGateways();
    }

    // Slot order, not write order: the counter wraps, so `four` and `five` came
    // after `three` and landed in the slots `three` left behind.
    expect(mockSecure.get(slotKey(0))).toBe('broken-four');
    expect(mockSecure.get(slotKey(1))).toBe('broken-five');
    expect(mockSecure.get(slotKey(2))).toBe('broken-three');
    expect(corruptCopies().size).toBe(3);
  });

  test('a rescue copy the secure store refuses does not break the load', async () => {
    const raw = '[{"id":"gw-1","token":"listen-hermes"';
    mockSecure.set(GATEWAYS_KEY, raw);
    mockSecureSet.mockImplementation(async (key: string) => {
      if (key.startsWith(CORRUPT_PREFIX)) throw new Error('secure store unavailable');
      mockSecure.set(key, raw);
    });

    await expect(loadGateways()).resolves.toEqual([]);
    expect(corruptCopies().size).toBe(0);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('could not be written');
  });

  test('a list that parses is not copied anywhere', async () => {
    mockSecure.set(GATEWAYS_KEY, JSON.stringify([profile({ id: 'gw-1' })]));

    await expect(loadGateways()).resolves.toEqual([profile({ id: 'gw-1' })]);
    expect(corruptCopies().size).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

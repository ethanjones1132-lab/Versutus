// Gateway profiles persist as one SecureStore item, so a blob that will not
// parse is the one failed read whose bytes are worth more than the empty list
// the load answers with: they hold every saved gateway and every token. It used
// to return `[]` and move on, and the next `upsertGateway` — which the operator
// reaches for precisely because nothing loaded — overwrote whatever it came
// from. So the raw string is parked under its own key first.

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

const profile = (overrides: Partial<GatewayProfile> & Pick<GatewayProfile, 'id'>): GatewayProfile => ({
  name: 'Gate',
  url: 'http://127.0.0.1:8760',
  createdAt: 1,
  ...overrides,
});

const corruptCopies = (): Map<string, string> =>
  new Map([...mockPlain].filter(([key]) => key.startsWith(CORRUPT_PREFIX)));

describe('a gateways blob that will not parse', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSecure.clear();
    mockPlain.clear();
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

  test('keeps the three newest copies and drops the rest', async () => {
    for (const attempt of ['one', 'two', 'three', 'four', 'five']) {
      mockSecure.set(GATEWAYS_KEY, `broken-${attempt}`);
      await loadGateways();
    }

    expect([...corruptCopies().values()]).toEqual(['broken-three', 'broken-four', 'broken-five']);
  });

  test('a list that parses is not copied anywhere', async () => {
    mockSecure.set(GATEWAYS_KEY, JSON.stringify([profile({ id: 'gw-1' })]));

    await expect(loadGateways()).resolves.toEqual([profile({ id: 'gw-1' })]);
    expect(corruptCopies().size).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// The provider's `bootstrap` reads four things in one `Promise.all` (the
// settings, the repaired gateways, the offline queue, the activity runs), so a
// single AsyncStorage read that throws takes the whole app down before it has
// rendered anything. These reads already treated an unparsable value as an empty
// one; a store that will not answer at all is the same kind of failure and was
// not treated as one.

const mockGet = jest.fn(async (_key: string): Promise<string | null> => null);
const mockSet = jest.fn(async (_key: string, _value: string) => undefined);
const mockRemove = jest.fn(async (_key: string) => undefined);

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: (key: string) => mockGet(key),
    setItem: (key: string, value: string) => mockSet(key, value),
    removeItem: (key: string) => mockRemove(key),
  },
}));

import { loadActivityRuns, loadActivityRunsFromStore, loadOfflineQueue } from '@/lib/gateway/session-persistence';

const refusing = async (): Promise<never> => {
  throw new Error('SQLite disk image is malformed');
};

describe('a store that will not hand the key over', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGet.mockReset().mockImplementation(refusing);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('the offline queue loads empty rather than failing the bootstrap', async () => {
    await expect(loadOfflineQueue()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('SQLite disk image is malformed');
  });

  test('the activity runs load empty rather than failing the bootstrap', async () => {
    await expect(loadActivityRuns()).resolves.toEqual([]);
    await expect(loadActivityRunsFromStore()).resolves.toEqual({ read: false, runs: [] });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('SQLite disk image is malformed');
  });

  test('a missing activity-runs key is a genuine empty roster, not a refused read', async () => {
    mockGet.mockReset().mockImplementation(async () => null);
    await expect(loadActivityRunsFromStore()).resolves.toEqual({ read: true, runs: [] });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('a value that will not parse is still an empty list, and still quiet about the cause', async () => {
    mockGet.mockReset().mockImplementation(async () => 'not json at all');

    await expect(loadOfflineQueue()).resolves.toEqual([]);
    await expect(loadActivityRuns()).resolves.toEqual([]);
    await expect(loadActivityRunsFromStore()).resolves.toEqual({ read: true, runs: [] });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

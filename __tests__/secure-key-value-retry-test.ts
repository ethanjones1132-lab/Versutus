type GlobalBacking = Record<string, unknown> & { __retryPlainBacking?: Map<string, string> };

// The plain store is what must stay empty, so it is a real (mocked) map the
// cases can look at rather than the native module jest has no handle for. The
// backing is stashed on globalThis because a jest module factory cannot close
// over file-level variables.
jest.mock('@react-native-async-storage/async-storage', () => {
  const globals = globalThis as GlobalBacking;
  const store: Map<string, string> = (globals.__retryPlainBacking ??= new Map());
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      getAllKeys: jest.fn(async () => [...store.keys()]),
      multiRemove: jest.fn(async (keys: string[]) => {
        keys.forEach((key) => store.delete(key));
      }),
    },
  };
});

const plain = (): Map<string, string> =>
  (globalThis as GlobalBacking).__retryPlainBacking ?? new Map();

import AsyncStorage from '@react-native-async-storage/async-storage';
import { secureKeyValueStorage, toSecureStoreKey } from '@/lib/storage/secure-key-value';

const globals = globalThis as typeof globalThis & { __DEV__?: boolean };

/**
 * Every gateway profile — tokens, model maps, locks — lives in ONE SecureStore
 * item, so this module is the only thing standing between a Keystore hiccup and
 * every saved credential. It used to catch ANY SecureStore error and report it
 * as the store being unavailable, which is a different fault with a different
 * remedy: in a production build the operator was told a dev-only fallback
 * refused them, and in dev a transient exception silently wrote a token to
 * plain AsyncStorage.
 *
 * (Every `await import('expo-secure-store')` throws under jest — dynamic import
 * needs --experimental-vm-modules — so the loader is a parameter here and these
 * cases hand it a store. That is the seam `secure-key-value-fallback-test.ts`
 * reaches the other way round, by never supplying one.)
 */
type FakeStore = {
  isAvailableAsync: jest.Mock;
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

function fakeStore(overrides: Partial<FakeStore> = {}): FakeStore {
  return {
    isAvailableAsync: jest.fn(async () => true),
    getItemAsync: jest.fn(async () => null),
    setItemAsync: jest.fn(async () => undefined),
    deleteItemAsync: jest.fn(async () => undefined),
    ...overrides,
  };
}

const loading = (store: FakeStore) => async () => store;

describe('a SecureStore that throws', () => {
  const originalDev = globals.__DEV__;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    plain().clear();
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globals.__DEV__ = originalDev;
    warnSpy.mockRestore();
  });

  test('a read that throws once is asked again, and the value comes back', async () => {
    const store = fakeStore({
      getItemAsync: jest
        .fn<Promise<string | null>, [string]>()
        .mockRejectedValueOnce(new Error('keystore busy'))
        .mockResolvedValue('listen-token'),
    });

    await expect(secureKeyValueStorage.getItem('versutus:gateways', loading(store))).resolves.toBe(
      'listen-token',
    );
    expect(store.getItemAsync).toHaveBeenCalledTimes(2);
  });

  test('a write that throws once is asked again, and the value is stored', async () => {
    const store = fakeStore({
      setItemAsync: jest
        .fn<Promise<void>, [string, string]>()
        .mockRejectedValueOnce(new Error('keystore busy'))
        .mockResolvedValue(undefined),
    });

    await secureKeyValueStorage.setItem('versutus:gateways', '[]', loading(store));

    expect(store.setItemAsync).toHaveBeenCalledTimes(2);
    expect(store.setItemAsync).toHaveBeenLastCalledWith('versutus_gateways', '[]');
  });

  test('a read that keeps throwing names the operation and the cause, not a missing store', async () => {
    const store = fakeStore({
      getItemAsync: jest.fn(async () => {
        throw new Error('keychain locked');
      }),
    });

    const failure = await secureKeyValueStorage
      .getItem('versutus:gateways', loading(store))
      .then(
        () => null,
        (error: unknown) => error as Error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('failed');
    expect(failure?.message).toContain('keychain locked');
    // The remedy this used to name is the wrong one: the store is there.
    expect(failure?.message).not.toContain('unavailable');
    expect(failure?.message).not.toContain('development-only');
  });

  test('a production write that keeps failing is named, and nothing reaches plain storage', async () => {
    globals.__DEV__ = false;
    const store = fakeStore({
      setItemAsync: jest.fn(async () => {
        throw new Error('user not present');
      }),
    });

    const failure = await secureKeyValueStorage
      .setItem('versutus:gateways', '[]', loading(store))
      .then(
        () => null,
        (error: unknown) => error as Error,
      );

    expect(failure?.message).toContain('failed');
    expect(failure?.message).toContain('user not present');
    expect(failure?.message).not.toContain('unavailable');
    // The dev-only fallback is not a write's remedy, in any build.
    expect(await AsyncStorage.getItem('versutus:gateways')).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('a remove that keeps throwing is named too', async () => {
    const store = fakeStore({
      deleteItemAsync: jest.fn(async () => {
        throw new Error('no such keystore');
      }),
    });

    await expect(secureKeyValueStorage.removeItem('versutus:gateways', loading(store))).rejects.toThrow(
      /remove of "versutus:gateways" failed: no such keystore/,
    );
  });
});

describe('a SecureStore that is not there', () => {
  const originalDev = globals.__DEV__;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    plain().clear();
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globals.__DEV__ = originalDev;
    warnSpy.mockRestore();
  });

  test('a store that says it is absent still refuses in a production build', async () => {
    globals.__DEV__ = false;
    const store = fakeStore({ isAvailableAsync: jest.fn(async () => false) });

    await expect(secureKeyValueStorage.setItem('k', 'v', loading(store))).rejects.toThrow(
      /development-only/,
    );
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });

  test('a store that says it is absent still falls back in a dev build', async () => {
    globals.__DEV__ = true;
    const store = fakeStore({ isAvailableAsync: jest.fn(async () => false) });

    await secureKeyValueStorage.setItem('k', 'v', loading(store));

    expect(store.setItemAsync).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem('k')).toBe('v');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('AsyncStorage');
  });

  test('a package that will not load is the same absent store, not a failed operation', async () => {
    globals.__DEV__ = false;
    const refusing = async () => {
      throw new Error('Cannot find module');
    };

    await expect(secureKeyValueStorage.getItem('k', refusing)).rejects.toThrow(/development-only/);
  });
});

describe('the pre-SecureStore value', () => {
  test('is still read from plain storage and migrated into the key space', async () => {
    const legacy = JSON.stringify([{ id: 'gw-1', token: 'listen-token' }]);
    await AsyncStorage.setItem('versutus:gateways', legacy);
    const store = fakeStore({ getItemAsync: jest.fn(async () => null) });

    const loaded = await secureKeyValueStorage.getItem('versutus:gateways', loading(store));

    expect(loaded).toBe(legacy);
    expect(store.setItemAsync).toHaveBeenCalledWith(toSecureStoreKey('versutus:gateways'), legacy);
    expect(await AsyncStorage.getItem('versutus:gateways')).toBeNull();
  });
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';

type GlobalBacking = Record<string, unknown> & { __secureFallbackBacking?: Map<string, string> };

// The backing Map is created inside the factory because jest module factories
// cannot close over file-level variables (only `mock`-prefixed names). It is
// stashed on globalThis so the tests below can reset it between cases.
jest.mock('@react-native-async-storage/async-storage', () => {
  const globals = globalThis as GlobalBacking;
  const store: Map<string, string> = (globals.__secureFallbackBacking ??= new Map());
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

const backing = (): Map<string, string> =>
  (globalThis as GlobalBacking).__secureFallbackBacking ?? new Map();

const globals = globalThis as typeof globalThis & { __DEV__?: boolean };

/**
 * The AsyncStorage fallback in `secure-key-value` holds secrets (gateway
 * tokens, device identity keys) unencrypted. The header comment promises it
 * exists "only in dev runtimes", but nothing enforced that: production builds
 * on a device without SecureStore silently kept secrets in plain storage.
 * These tests pin the enforcement — loud in dev, refused in production.
 *
 * (Under jest every `await import('expo-secure-store')` throws — dynamic
 * import needs --experimental-vm-modules — so this suite always exercises the
 * fallback branch. The SecureStore happy path above it is intentionally left
 * untouched by the change.)
 */
describe('secure-key-value insecure fallback', () => {
  const originalDev = globals.__DEV__;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    backing().clear();
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globals.__DEV__ = originalDev;
    warnSpy.mockRestore();
  });

  test('native tests exercise the fallback branch, not the web branch', () => {
    expect(Platform.OS).not.toBe('web');
  });

  test('dev writes fall back to AsyncStorage with a warning naming the key', async () => {
    globals.__DEV__ = true;

    await secureKeyValueStorage.setItem('gateway:list', 'secret-blob');

    expect(await AsyncStorage.getItem('gateway:list')).toBe('secret-blob');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('gateway:list');
    expect(message).toContain('AsyncStorage');
  });

  test('dev reads fall back to AsyncStorage with a warning', async () => {
    globals.__DEV__ = true;
    await AsyncStorage.setItem('gateway:list', 'secret-blob');

    const value = await secureKeyValueStorage.getItem('gateway:list');

    expect(value).toBe('secret-blob');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('AsyncStorage');
  });

  test('dev removes fall back to AsyncStorage with a warning', async () => {
    globals.__DEV__ = true;
    await AsyncStorage.setItem('gateway:list', 'secret-blob');

    await secureKeyValueStorage.removeItem('gateway:list');

    expect(await AsyncStorage.getItem('gateway:list')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('production writes refuse the fallback and keep nothing in plain storage', async () => {
    globals.__DEV__ = false;

    await expect(secureKeyValueStorage.setItem('gateway:list', 'secret-blob')).rejects.toThrow(
      /development-only/,
    );

    expect(await AsyncStorage.getItem('gateway:list')).toBeNull();
  });

  test('production reads refuse the fallback instead of returning plain storage', async () => {
    globals.__DEV__ = false;
    await AsyncStorage.setItem('gateway:list', 'secret-blob');

    await expect(secureKeyValueStorage.getItem('gateway:list')).rejects.toThrow(
      /development-only/,
    );
  });

  test('production removes refuse the fallback instead of touching plain storage', async () => {
    globals.__DEV__ = false;
    await AsyncStorage.setItem('gateway:list', 'secret-blob');

    await expect(secureKeyValueStorage.removeItem('gateway:list')).rejects.toThrow(
      /development-only/,
    );

    expect(await AsyncStorage.getItem('gateway:list')).toBe('secret-blob');
  });
});

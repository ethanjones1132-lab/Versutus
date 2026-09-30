// ─── Secure key-value storage ─────────────────────────────────────
// SecureStore-backed persistence for secrets (gateway tokens, device
// identity keys). Falls back to AsyncStorage only in dev runtimes where
// SecureStore is unavailable. Web uses localStorage (same as the plain
// store — browser security model applies).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

function readWebValue(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeWebValue(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Ignore locked-down browser storage.
  }
}

function removeWebValue(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Ignore locked-down browser storage.
  }
}

/**
 * SecureStore only accepts a restricted key alphabet. Keep the logical key
 * unchanged for the AsyncStorage fallback so values written by older builds
 * can still be read and migrated.
 */
export function toSecureStoreKey(key: string): string {
  const normalized = key.replace(/[^A-Za-z0-9._-]/g, '_');
  return normalized || 'versutus';
}

/**
 * Gate the plain-AsyncStorage fallback used when SecureStore is unavailable.
 * Secrets kept there (gateway tokens, device identity keys) are unencrypted,
 * so the fallback is a dev-runtimes-only escape hatch: simulators without a
 * keychain keep working, but loudly. Production builds run on real devices
 * where SecureStore is always available, so a missing SecureStore there
 * refuses rather than silently downgrading secret storage.
 */
function allowInsecureFallback(operation: 'read' | 'write' | 'remove', key: string): void {
  if (!__DEV__) {
    throw new Error(
      `[secure-key-value] SecureStore is unavailable, and the plain-storage fallback is development-only — refusing to ${operation} "${key}" in a production build.`,
    );
  }
  console.warn(
    `[secure-key-value] SecureStore is unavailable — ${operation} "${key}" falls back to plain AsyncStorage. ` +
      'Secrets kept there are unencrypted; this fallback is development-only.',
  );
}

/** The SecureStore surface this module uses, so a loader can stand in for it. */
type SecureStore = Pick<
  typeof import('expo-secure-store'),
  'isAvailableAsync' | 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync'
>;

/**
 * SecureStore is loaded on the first call rather than imported statically, so a
 * client with no keychain behind it (Expo Go) still runs. Under jest every
 * dynamic import throws, so the loader is a parameter and the retry below is
 * reachable from a test — the same seam `widget-device.ts` uses.
 */
type LoadSecureStore = () => Promise<SecureStore>;

const loadSecureStore: LoadSecureStore = async () => await import('expo-secure-store');

/**
 * How long to wait before the single retry. A Keystore call that throws is a
 * transient Keystore fault far more often than it is a broken store, and the
 * value is lost either way unless the operation is asked again.
 */
const SECURE_STORE_RETRY_MS = 150;

/** What a probe inside the retried operation answers when the store is absent. */
const STORE_ABSENT = Symbol('secure-store-absent');

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The package itself would not load: as unavailable as a store gets. */
async function loadStoreOrNull(load: LoadSecureStore): Promise<SecureStore | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/**
 * Ask the store for one operation, once more if it throws.
 *
 * A thrown Keystore call and a missing keychain are different faults and only
 * one of them is the dev-only fallback's business. Told the wrong one, a
 * transient exception reads as a policy refusal in a production build, and in
 * dev it writes a gateway token to plain storage. So the retry happens here and
 * a store that is present and still failing is named with the cause that
 * actually stopped it.
 */
async function runSecureStore<T>(
  operation: 'read' | 'write' | 'remove',
  key: string,
  run: () => Promise<T | typeof STORE_ABSENT>,
): Promise<T | typeof STORE_ABSENT> {
  try {
    return await run();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, SECURE_STORE_RETRY_MS));
  }
  try {
    return await run();
  } catch (cause) {
    throw new Error(`[secure-key-value] SecureStore ${operation} of "${key}" failed: ${causeText(cause)}`);
  }
}

export const secureKeyValueStorage = {
  async getItem(key: string, load: LoadSecureStore = loadSecureStore): Promise<string | null> {
    if (Platform.OS === 'web') return readWebValue(key);
    const secureKey = toSecureStoreKey(key);
    const store = await loadStoreOrNull(load);
    if (store) {
      const held = await runSecureStore('read', key, async () => {
        if (!(await store.isAvailableAsync())) return STORE_ABSENT;
        const value = await store.getItemAsync(secureKey);
        if (value !== null) return value;

        // Older builds fell back to AsyncStorage after SecureStore rejected
        // colon-delimited keys. Migrate that value into the valid key space.
        const legacyValue = await AsyncStorage.getItem(key);
        if (legacyValue !== null) {
          try {
            await store.setItemAsync(secureKey, legacyValue);
            await AsyncStorage.removeItem(key);
          } catch {
            // Keep the legacy fallback if migration is unavailable.
          }
        }
        return legacyValue;
      });
      if (held !== STORE_ABSENT) return held;
    }
    allowInsecureFallback('read', key);
    return AsyncStorage.getItem(key);
  },

  async setItem(key: string, value: string, load: LoadSecureStore = loadSecureStore): Promise<void> {
    if (Platform.OS === 'web') {
      writeWebValue(key, value);
      return;
    }
    const secureKey = toSecureStoreKey(key);
    const store = await loadStoreOrNull(load);
    if (store) {
      const written = await runSecureStore('write', key, async () => {
        if (!(await store.isAvailableAsync())) return STORE_ABSENT;
        await store.setItemAsync(secureKey, value);
        // Remove a value left by the pre-SecureStore migration fallback.
        await AsyncStorage.removeItem(key);
      });
      if (written !== STORE_ABSENT) return;
    }
    allowInsecureFallback('write', key);
    await AsyncStorage.setItem(key, value);
  },

  async removeItem(key: string, load: LoadSecureStore = loadSecureStore): Promise<void> {
    if (Platform.OS === 'web') {
      removeWebValue(key);
      return;
    }
    const secureKey = toSecureStoreKey(key);
    const store = await loadStoreOrNull(load);
    if (store) {
      const removed = await runSecureStore('remove', key, async () => {
        if (!(await store.isAvailableAsync())) return STORE_ABSENT;
        await store.deleteItemAsync(secureKey);
        await AsyncStorage.removeItem(key);
      });
      if (removed !== STORE_ABSENT) return;
    }
    allowInsecureFallback('remove', key);
    await AsyncStorage.removeItem(key);
  },
};

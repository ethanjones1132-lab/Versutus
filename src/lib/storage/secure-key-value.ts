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

export const secureKeyValueStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return readWebValue(key);
    const secureKey = toSecureStoreKey(key);
    try {
      const SecureStore = await import('expo-secure-store');
      if (await SecureStore.isAvailableAsync()) {
        const value = await SecureStore.getItemAsync(secureKey);
        if (value !== null) return value;

        // Older builds fell back to AsyncStorage after SecureStore rejected
        // colon-delimited keys. Migrate that value into the valid key space.
        const legacyValue = await AsyncStorage.getItem(key);
        if (legacyValue !== null) {
          try {
            await SecureStore.setItemAsync(secureKey, legacyValue);
            await AsyncStorage.removeItem(key);
          } catch {
            // Keep the legacy fallback if migration is unavailable.
          }
        }
        return legacyValue;
      }
    } catch {
      // Fall through to the dev-only AsyncStorage fallback below.
    }
    allowInsecureFallback('read', key);
    return AsyncStorage.getItem(key);
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      writeWebValue(key, value);
      return;
    }
    const secureKey = toSecureStoreKey(key);
    try {
      const SecureStore = await import('expo-secure-store');
      if (await SecureStore.isAvailableAsync()) {
        await SecureStore.setItemAsync(secureKey, value);
        // Remove a value left by the pre-SecureStore migration fallback.
        await AsyncStorage.removeItem(key);
        return;
      }
    } catch {
      // Fall through to the dev-only AsyncStorage fallback below.
    }
    allowInsecureFallback('write', key);
    await AsyncStorage.setItem(key, value);
  },

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      removeWebValue(key);
      return;
    }
    const secureKey = toSecureStoreKey(key);
    try {
      const SecureStore = await import('expo-secure-store');
      if (await SecureStore.isAvailableAsync()) {
        await SecureStore.deleteItemAsync(secureKey);
        await AsyncStorage.removeItem(key);
        return;
      }
    } catch {
      // Fall through to the dev-only AsyncStorage fallback below.
    }
    allowInsecureFallback('remove', key);
    await AsyncStorage.removeItem(key);
  },
};

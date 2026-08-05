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

export const secureKeyValueStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return readWebValue(key);
    try {
      const SecureStore = await import('expo-secure-store');
      if (await SecureStore.isAvailableAsync()) {
        return SecureStore.getItemAsync(key);
      }
    } catch {
      // Fall through to AsyncStorage for dev runtimes.
    }
    return AsyncStorage.getItem(key);
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      writeWebValue(key, value);
      return;
    }
    try {
      const SecureStore = await import('expo-secure-store');
      if (await SecureStore.isAvailableAsync()) {
        await SecureStore.setItemAsync(key, value);
        return;
      }
    } catch {
      // Fall through to AsyncStorage for dev runtimes.
    }
    await AsyncStorage.setItem(key, value);
  },

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      removeWebValue(key);
      return;
    }
    try {
      const SecureStore = await import('expo-secure-store');
      if (await SecureStore.isAvailableAsync()) {
        await SecureStore.deleteItemAsync(key);
        return;
      }
    } catch {
      // Fall through to AsyncStorage for dev runtimes.
    }
    await AsyncStorage.removeItem(key);
  },
};

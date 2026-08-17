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
    // Ignore locked-down browser storage; callers still get a usable in-memory run.
  }
}

function removeWebValue(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Ignore locked-down browser storage.
  }
}

function readWebKeys(): string[] {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return [];
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

export const keyValueStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return readWebValue(key);
    return AsyncStorage.getItem(key);
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      writeWebValue(key, value);
      return;
    }
    await AsyncStorage.setItem(key, value);
  },

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      removeWebValue(key);
      return;
    }
    await AsyncStorage.removeItem(key);
  },

  /** Every key currently held, so callers can clean up by prefix. */
  async getAllKeys(): Promise<string[]> {
    if (Platform.OS === 'web') return readWebKeys();
    return [...(await AsyncStorage.getAllKeys())];
  },

  async multiRemove(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (Platform.OS === 'web') {
      for (const key of keys) removeWebValue(key);
      return;
    }
    await AsyncStorage.multiRemove(keys);
  },
};

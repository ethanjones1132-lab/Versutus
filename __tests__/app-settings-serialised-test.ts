// ─── The settings blob is written by two writers ────────────────────────────
// The Settings screen writes the voice engine and the provider's connect
// ladder writes `lastSuccessfulUrl` / the onboarding patch, both from timers
// of their own. Unserialised, whichever `setItem` lands last wins with the
// base it read, and the other writer's field is gone for the session — the
// compiled-in fallback host list or the onboarding redirect with it.

import { loadAppSettings, saveAppSettings } from '@/lib/settings/app-settings';

jest.mock('@/lib/storage/key-value', () => {
  const store = new Map<string, string>();
  const state = { failNextWrite: false };
  return {
    store,
    state,
    keyValueStorage: {
      // Each storage call yields the event loop, as AsyncStorage's do, so two
      // overlapping read-modify-write pairs really do interleave here.
      getItem: jest.fn(async (key: string) => {
        await Promise.resolve();
        return store.get(key) ?? null;
      }),
      setItem: jest.fn(async (key: string, value: string) => {
        await Promise.resolve();
        if (state.failNextWrite) {
          state.failNextWrite = false;
          throw new Error('The database is full');
        }
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        await Promise.resolve();
        store.delete(key);
      }),
    },
  };
});

const storage = jest.requireMock('@/lib/storage/key-value') as {
  store: Map<string, string>;
  state: { failNextWrite: boolean };
  keyValueStorage: { getItem: jest.Mock; setItem: jest.Mock };
};

const SETTINGS_KEY = 'versutus:app-settings';

function stored(): Record<string, unknown> {
  const raw = storage.store.get(SETTINGS_KEY);
  if (raw === undefined) throw new Error('nothing was written');
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(async () => {
  storage.store.clear();
  storage.state.failNextWrite = false;
  storage.keyValueStorage.getItem.mockClear();
  storage.keyValueStorage.setItem.mockClear();
  // A rejected write must not leave its record in the queue for the next case.
  await saveAppSettings({ onboardingComplete: true });
  storage.store.clear();
});

describe('two overlapping writers of the settings blob', () => {
  test('both fields survive: each write merges onto what the previous one stored', async () => {
    await Promise.all([
      saveAppSettings({ voiceEngine: 'local' }),
      saveAppSettings({ lastSuccessfulUrl: 'ws://home.test:9000' }),
    ]);

    expect(stored()).toMatchObject({
      voiceEngine: 'local',
      lastSuccessfulUrl: 'ws://home.test:9000',
    });
  });

  test('the second writer reads the first writer\u2019s field, not the blob before it', async () => {
    await saveAppSettings({ voiceEngine: 'codex' });
    await saveAppSettings({ pcName: 'Home PC' });

    expect(stored()).toMatchObject({ voiceEngine: 'codex', pcName: 'Home PC' });
  });

  test('a refused write rejects its own caller and the next write still lands', async () => {
    storage.state.failNextWrite = true;
    await expect(saveAppSettings({ voiceEngine: 'phone' })).rejects.toThrow('database is full');

    // Nothing was stored, and the queue was not poisoned by the refusal.
    await expect(saveAppSettings({ pcName: 'Studio' })).resolves.toMatchObject({ pcName: 'Studio' });
    expect(stored()).toMatchObject({ pcName: 'Studio' });
  });

  test('the returned value is the merged blob, and the engine stays normalised', async () => {
    const saved = await saveAppSettings({ voiceEngine: 'local' });
    expect(saved.voiceEngine).toBe('local');
    const second = await saveAppSettings({ pcName: 'Laptop' });
    // The second caller still sees the engine the first one stored.
    expect(second).toMatchObject({ voiceEngine: 'local', pcName: 'Laptop' });
  });
});

describe('a settings read the store cannot answer', () => {
  test('load answers with the defaults instead of rejecting every caller', async () => {
    storage.keyValueStorage.getItem.mockRejectedValueOnce(new Error('AsyncStorage is unavailable'));
    await expect(loadAppSettings()).resolves.toMatchObject({
      autoConnect: true,
      onboardingComplete: false,
      voiceEngine: 'auto',
    });
  });

  test('an unreadable blob refuses the write rather than being overwritten with defaults', async () => {
    storage.keyValueStorage.getItem.mockRejectedValueOnce(new Error('AsyncStorage is unavailable'));
    await expect(saveAppSettings({ pcName: 'Nope' })).rejects.toThrow('unavailable');
    expect(storage.store.get(SETTINGS_KEY)).toBeUndefined();
  });
});
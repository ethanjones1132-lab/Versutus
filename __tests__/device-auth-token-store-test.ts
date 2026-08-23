import {
  clearDeviceAuthToken,
  saveDeviceAuthToken,
} from '@/lib/gateway/device-auth-token';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';

jest.mock('@/lib/storage/secure-key-value', () => ({
  secureKeyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockGet = secureKeyValueStorage.getItem as jest.Mock;
const mockSet = secureKeyValueStorage.setItem as jest.Mock;
const mockRemove = secureKeyValueStorage.removeItem as jest.Mock;

const KEY = 'versutus:device-auth-token:v1';

/**
 * The token store is one JSON blob, so save/clear are read-modify-write over
 * the WHOLE store. If two mutations overlap, the second write erases the
 * first — e.g. a pairing that saves the operator role can silently delete a
 * concurrently saved observer role. These tests pin the serialization: every
 * mutation must observe what the previous mutation wrote.
 */
describe('device auth token store', () => {
  const backing = new Map<string, string>();

  const flushMicrotasks = async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  };

  const readStore = (): {
    version: number;
    deviceId: string;
    tokens: Record<string, { token: string; role: string }>;
  } => {
    const raw = backing.get(KEY);
    if (!raw) throw new Error('expected the device auth token store to be present');
    return JSON.parse(raw) as ReturnType<typeof readStore>;
  };

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
    mockRemove.mockReset().mockImplementation(async (key: string) => {
      backing.delete(key);
    });
  });

  test('concurrent saves for different roles keep both tokens', async () => {
    await Promise.all([
      saveDeviceAuthToken({ deviceId: 'dev-1', role: 'operator', token: 'tok-op' }),
      saveDeviceAuthToken({ deviceId: 'dev-1', role: 'observer', token: 'tok-ob' }),
    ]);

    const store = readStore();
    expect(Object.keys(store.tokens).sort()).toEqual(['observer', 'operator']);
    expect(store.tokens.operator.token).toBe('tok-op');
    expect(store.tokens.observer.token).toBe('tok-ob');
  });

  test('a queued mutation waits for the in-flight write instead of reading underneath it', async () => {
    let releaseWrite!: () => void;
    const writeHold = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    mockSet.mockImplementationOnce(async (key: string, value: string) => {
      await writeHold;
      backing.set(key, value);
    });

    const first = saveDeviceAuthToken({ deviceId: 'dev-2', role: 'operator', token: 'tok-1' });
    await flushMicrotasks();
    expect(mockGet).toHaveBeenCalledTimes(1);

    const second = saveDeviceAuthToken({ deviceId: 'dev-2', role: 'observer', token: 'tok-2' });
    await flushMicrotasks();
    // The first save's write is still held, so the second save must not have
    // read yet — reading now would build its store on pre-write state.
    expect(mockGet).toHaveBeenCalledTimes(1);

    releaseWrite();
    await Promise.all([first, second]);

    const store = readStore();
    expect(store.tokens.operator.token).toBe('tok-1');
    expect(store.tokens.observer.token).toBe('tok-2');
  });

  test('a clear racing a save leaves the surviving roles intact', async () => {
    await saveDeviceAuthToken({ deviceId: 'dev-3', role: 'operator', token: 'tok-op' });
    await saveDeviceAuthToken({ deviceId: 'dev-3', role: 'observer', token: 'tok-ob' });

    await Promise.all([
      clearDeviceAuthToken('dev-3', 'operator'),
      saveDeviceAuthToken({ deviceId: 'dev-3', role: 'ephemeral', token: 'tok-ep' }),
    ]);

    const store = readStore();
    expect(store.tokens.operator).toBeUndefined();
    expect(store.tokens.observer.token).toBe('tok-ob');
    expect(store.tokens.ephemeral.token).toBe('tok-ep');
  });

  test('clearing the final role drops the store key entirely', async () => {
    await saveDeviceAuthToken({ deviceId: 'dev-4', role: 'solo', token: 'tok-only' });

    await clearDeviceAuthToken('dev-4', 'solo');

    expect(backing.has(KEY)).toBe(false);
    expect(mockRemove).toHaveBeenCalledWith(KEY);
  });

  test('a failed write rejects its caller without stranding later mutations', async () => {
    mockSet.mockImplementationOnce(async () => {
      throw new Error('storage unavailable');
    });

    await expect(
      saveDeviceAuthToken({ deviceId: 'dev-5', role: 'ghost', token: 'tok-x' }),
    ).rejects.toThrow('storage unavailable');

    await saveDeviceAuthToken({ deviceId: 'dev-5', role: 'operator', token: 'tok-op' });

    const store = readStore();
    expect(store.tokens.operator.token).toBe('tok-op');
    expect(store.tokens.ghost).toBeUndefined();
  });
});

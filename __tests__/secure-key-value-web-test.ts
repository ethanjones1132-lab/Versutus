type PlainBacking = Record<string, unknown> & { __webPlainBacking?: Map<string, string> };

// The plain store must stay untouched on web, so it is a real (mocked) map the
// cases can look at instead of the native module jest has no handle for. The
// backing is stashed on globalThis because a jest module factory cannot close
// over file-level variables, and it must survive `jest.resetModules()` (each
// reset re-runs the factory but the operator's disk does not move).
jest.mock('@react-native-async-storage/async-storage', () => {
  const globals = globalThis as PlainBacking;
  const store: Map<string, string> = (globals.__webPlainBacking ??= new Map());
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
  ((globalThis as PlainBacking).__webPlainBacking ??= new Map());

type SecureModule = typeof import('@/lib/storage/secure-key-value');
type PlainModule = typeof import('@/lib/storage/key-value');

/**
 * `localStorage` does not exist in jest-expo's Node environment, and the point
 * of these cases is what a browser can read back out of it after a reload. So
 * the page gets a real key/value cell map with the same surface the storage
 * modules use, installed on globalThis for the duration of one case.
 */
interface FakeLocalStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function fakeLocalStorage(): FakeLocalStorage {
  const cells = new Map<string, string>();
  return {
    get length() {
      return cells.size;
    },
    key: (index: number) => [...cells.keys()][index] ?? null,
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cells.set(key, value);
    },
    removeItem: (key: string) => {
      cells.delete(key);
    },
    clear: () => {
      cells.clear();
    },
  };
}

function installLocalStorage(storage: FakeLocalStorage): void {
  (globalThis as unknown as { localStorage: FakeLocalStorage }).localStorage = storage;
}

function removeLocalStorage(): void {
  delete (globalThis as unknown as { localStorage?: FakeLocalStorage }).localStorage;
}

/**
 * One page load: a fresh module registry with the platform set to web.
 *
 * `jest.resetModules()` is the reload — the session memory is module state, so
 * a fresh registry starts with none of it, exactly as a browser does. jest-expo
 * defaults to ios and a reset also replaces the react-native instance, so the
 * platform is assigned on THAT instance before the storage modules load
 * against it; assigning the imported one would be lost with the old instance.
 * The fake localStorage survives, because a browser's does.
 */
function webPage(): {
  secure: SecureModule['secureKeyValueStorage'];
  plain: PlainModule['keyValueStorage'];
} {
  jest.resetModules();
  const { Platform } = jest.requireActual<typeof import('react-native')>('react-native');
  // `Platform.OS` is a plain property at runtime, but its declared type is the
  // per-platform literal union, so the write goes through a cast.
  (Platform as unknown as { OS: string }).OS = 'web';
  return {
    secure: jest.requireActual<SecureModule>('@/lib/storage/secure-key-value')
      .secureKeyValueStorage,
    plain: jest.requireActual<PlainModule>('@/lib/storage/key-value').keyValueStorage,
  };
}

const GATEWAYS_KEY = 'versutus:gateways';
const TOKEN_VALUE = 'listen-token-that-must-not-outlive-the-tab';
const GATEWAYS_BLOB = JSON.stringify([{ id: 'gw-1', token: TOKEN_VALUE }]);

describe('secure-key-value on web', () => {
  let web: FakeLocalStorage;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    plain().clear();
    web = fakeLocalStorage();
    installLocalStorage(web);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    removeLocalStorage();
    warnSpy.mockRestore();
  });

  test('a gateway token written on web is not readable from localStorage', async () => {
    const { secure } = webPage();

    await secure.setItem(GATEWAYS_KEY, GATEWAYS_BLOB);

    expect(web.getItem(GATEWAYS_KEY)).toBeNull();
    // Nothing else was parked under another key either, and the plain
    // AsyncStorage store (not even reached in a browser) holds nothing.
    expect(web.length).toBe(0);
    expect(plain().size).toBe(0);
  });

  test('a read in the same tab still returns what the tab wrote', async () => {
    const { secure } = webPage();

    await secure.setItem(GATEWAYS_KEY, GATEWAYS_BLOB);

    await expect(secure.getItem(GATEWAYS_KEY)).resolves.toBe(GATEWAYS_BLOB);
  });

  test('a reload forgets the token instead of reading it back', async () => {
    const before = webPage();
    await before.secure.setItem(GATEWAYS_KEY, GATEWAYS_BLOB);

    const after = webPage();

    await expect(after.secure.getItem(GATEWAYS_KEY)).resolves.toBeNull();
    expect(web.getItem(GATEWAYS_KEY)).toBeNull();
  });

  test('the module says why the secret will not be there after a reload', async () => {
    const { secure } = webPage();

    await secure.setItem(GATEWAYS_KEY, GATEWAYS_BLOB);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session only'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('localStorage'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(GATEWAYS_KEY));
    // The value itself never belongs in a log line.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(TOKEN_VALUE));
  });

  test('a plaintext copy an older web build left is removed, not answered', async () => {
    web.setItem(GATEWAYS_KEY, GATEWAYS_BLOB);
    const { secure } = webPage();

    await expect(secure.getItem(GATEWAYS_KEY)).resolves.toBeNull();

    expect(web.getItem(GATEWAYS_KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('older web build'));
  });

  test('removing a web secret forgets it in the session too', async () => {
    const { secure } = webPage();
    await secure.setItem(GATEWAYS_KEY, GATEWAYS_BLOB);

    await secure.removeItem(GATEWAYS_KEY);

    await expect(secure.getItem(GATEWAYS_KEY)).resolves.toBeNull();
    expect(web.getItem(GATEWAYS_KEY)).toBeNull();
  });

  test('non-secret settings still round-trip through localStorage on web', async () => {
    // `app-settings` rides `keyValueStorage`, the settings lane; its values are
    // not secrets and are meant to survive a reload. Only the secure lane
    // changed, so this must keep working.
    const settingsKey = 'versutus:app-settings';
    const settings = JSON.stringify({
      autoConnect: true,
      onboardingComplete: true,
      voiceEngine: 'local',
    });
    const before = webPage();

    await before.plain.setItem(settingsKey, settings);

    const after = webPage();
    await expect(after.plain.getItem(settingsKey)).resolves.toBe(settings);
    expect(web.getItem(settingsKey)).toBe(settings);
  });
});

// Keep this file a module: its helpers share names with other test files, and
// a script's top-level declarations would be global to the whole TS program.
export {};

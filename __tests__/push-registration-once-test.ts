// Push registration: what the phone must not forget to do, and what it must not
// keep doing.
//
// Two defects are pinned here:
// - NOTIF-07: `obtainGrantedExpoPushToken` persisted the token BEFORE returning
//   it, and turned any throw into `null`. A single Keystore hiccup (secure-key-
//   value retries once, then throws) therefore read as "this device has no token"
//   and the registration never happened — silently, for the rest of the session.
//   The cache write exists only so a rotation is noticed, so it may not veto the
//   registration.
// - NOTIF-08: `syncPushRegistration` re-fetched the token and re-POSTed it on
//   every `connected` transition — roughly every 30–70 s on a flapping link, and
//   the silent self-heal connections count. A registration that landed and has
//   not changed now stands for the next six hours; a rotation, a gateway change
//   or a refused register still registers.

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  registerTaskAsync: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { easConfig: { projectId: '52545800-300a-4bbc-a2b9-7e412d9c217e' } },
}));

jest.mock('@/lib/storage/secure-key-value', () => ({
  secureKeyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(),
}));

type ReactNative = typeof import('react-native');
type PushRegistration = typeof import('@/lib/notifications/push-registration');
type NotificationsMock = {
  getPermissionsAsync: jest.Mock;
  getExpoPushTokenAsync: jest.Mock;
  registerTaskAsync: jest.Mock;
};
type StorageMock = {
  secureKeyValueStorage: { getItem: jest.Mock; setItem: jest.Mock; removeItem: jest.Mock };
};
type IdentityMock = { loadOrCreateDeviceIdentity: jest.Mock };

// What is under test is module-level state (the registration this process
// completed), so every case gets a fresh copy of the module — and the platform
// that copy reads comes back with it, which is why `platform` is handed out
// rather than imported.
function freshRegistration(): {
  push: PushRegistration;
  platform: ReactNative['Platform'];
  permissions: jest.Mock;
  token: jest.Mock;
  widgetTask: jest.Mock;
  storeGet: jest.Mock;
  storeSet: jest.Mock;
} {
  jest.resetModules();
  // The mocked modules are re-required after the reset, so the fresh copy of the
  // module under test and this test are talking to the same instances.
  const notifications = jest.requireMock<NotificationsMock>('expo-notifications');
  const storage = jest.requireMock<StorageMock>('@/lib/storage/secure-key-value');
  const identity = jest.requireMock<IdentityMock>('@/lib/gateway/device-identity');
  identity.loadOrCreateDeviceIdentity.mockResolvedValue({ deviceId: 'a'.repeat(64) });
  // A store that actually holds what it was given: the registration this
  // process completed is only fresh while the token it wrote down is the token
  // the Gate holds.
  const held: Record<string, string> = {};
  storage.secureKeyValueStorage.getItem.mockImplementation(async (key: string) => held[key] ?? null);
  storage.secureKeyValueStorage.setItem.mockImplementation(async (key: string, value: string) => {
    held[key] = value;
  });
  notifications.registerTaskAsync.mockResolvedValue(undefined);
  notifications.getPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' });
  notifications.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[new]' });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  return {
    push: jest.requireActual<PushRegistration>('@/lib/notifications/push-registration'),
    platform: jest.requireActual<ReactNative>('react-native').Platform,
    permissions: notifications.getPermissionsAsync,
    token: notifications.getExpoPushTokenAsync,
    widgetTask: notifications.registerTaskAsync,
    storeGet: storage.secureKeyValueStorage.getItem,
    storeSet: storage.secureKeyValueStorage.setItem,
  };
}

/** The `client.rpcRequest` seam the registration functions take. */
function rpcStub(): { rpcRequest: jest.Mock } {
  return { rpcRequest: jest.fn().mockResolvedValue({}) };
}

/** How many registrations the Gate was asked for. */
function registers(rpc: { rpcRequest: jest.Mock }): number {
  return rpc.rpcRequest.mock.calls.filter((call) => call[0] === 'notifications.register').length;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a token whose cache write failed', () => {
  test('is still handed to the Gate', async () => {
    const { push, storeSet } = freshRegistration();
    storeSet.mockRejectedValue(new Error('keystore unavailable'));
    const rpc = rpcStub();

    await push.syncPushRegistration(rpc);

    // The write exists only so a rotation is noticed. Letting it veto the
    // registration turned one Keystore hiccup into "push stopped", silently.
    expect(storeSet).toHaveBeenCalled();
    expect(registers(rpc)).toBe(1);
    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.register',
      expect.objectContaining({ expoPushToken: 'ExponentPushToken[new]' }),
    );
  });
});

describe('a registration that already landed', () => {
  test('is not repeated for the next connect', async () => {
    const { push, token } = freshRegistration();
    const rpc = rpcStub();

    await push.syncPushRegistration(rpc);
    await push.syncPushRegistration(rpc);

    // One native token read and one Gate request between them, not one each:
    // the token the Gate holds has not changed.
    expect(registers(rpc)).toBe(1);
    expect(token).toHaveBeenCalledTimes(1);
  });

  test('asks the phone for the widget task once, not once per connect', async () => {
    const { push, platform, widgetTask } = freshRegistration();
    // The widget push task is Android's alone, so the case that counts it runs
    // on Android.
    jest.replaceProperty(platform, 'OS', 'android');
    const rpc = rpcStub();

    await push.syncPushRegistration(rpc);
    await push.syncPushRegistration(rpc);

    // The widget keeps the task Android registered for it, so re-registering
    // the same name on every reconnect buys a native round trip and nothing.
    expect(widgetTask).toHaveBeenCalledTimes(1);
  });

  test('is written down again once the window has passed', async () => {
    jest.useFakeTimers();
    try {
      const { push } = freshRegistration();
      const rpc = rpcStub();

      await push.syncPushRegistration(rpc);
      jest.advanceTimersByTime(30_000);
      await push.syncPushRegistration(rpc);
      expect(registers(rpc)).toBe(1);

      // Six hours on, a Gate that lost the row (or a device that was swapped)
      // must be written down again: the fresh window is a bound, not a latch.
      jest.advanceTimersByTime(6 * 60 * 60 * 1000);
      await push.syncPushRegistration(rpc);

      expect(registers(rpc)).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('registers again when the token on the phone has rotated', async () => {
    const { push, storeGet } = freshRegistration();
    const rpc = rpcStub();

    await push.syncPushRegistration(rpc);
    // A rotation this process has noticed on the way in: the stored token is no
    // longer the one the Gate was given, so the Gate is holding a token this
    // device no longer has.
    storeGet.mockResolvedValue('ExponentPushToken[rotated]');
    await push.syncPushRegistration(rpc);

    expect(registers(rpc)).toBe(2);
  });

  test('registers again for a gateway this device has just left', async () => {
    const { push } = freshRegistration();
    const first = rpcStub();
    await push.syncPushRegistration(first);

    // Leaving a Gate deregisters this device from it (both teardowns do), and
    // the Gate that answers next has never been told about this device at all.
    await push.deregisterWithGate(first);

    const next = rpcStub();
    await push.syncPushRegistration(next);

    expect(registers(first)).toBe(1);
    expect(registers(next)).toBe(1);
  });

  test('is retried at the next connect when the Gate refused it', async () => {
    const { push } = freshRegistration();
    const rpc = rpcStub();
    rpc.rpcRequest.mockRejectedValueOnce(new Error('pairing_required'));

    await push.syncPushRegistration(rpc);
    await push.syncPushRegistration(rpc);

    // Nothing landed, so nothing is remembered: the refusal must not be paid
    // for by skipping the next six hours of registrations.
    expect(registers(rpc)).toBe(2);
  });

  test('one pass serves two connects that overlap', async () => {
    const { push, token } = freshRegistration();
    const rpc = rpcStub();

    // The connect path fires this per `connected` transition, and a silent
    // self-heal can land on top of a real one in the same tick.
    await Promise.all([push.syncPushRegistration(rpc), push.syncPushRegistration(rpc)]);

    expect(registers(rpc)).toBe(1);
    expect(token).toHaveBeenCalledTimes(1);
  });

  test('web still registers nothing', async () => {
    const { push, platform } = freshRegistration();
    jest.replaceProperty(platform, 'OS', 'web');
    const rpc = rpcStub();

    await push.syncPushRegistration(rpc);
    await push.syncPushRegistration(rpc);

    expect(rpc.rpcRequest).not.toHaveBeenCalled();
  });
});
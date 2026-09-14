// ─── The connected edge registers the Expo push token (Solution A2) ─────────
// `syncPushRegistration` had zero callers: the Gate half (`notifications.register`
// on the dispatch table) was live, the app half was not. This pins the fold —
// a token is registered under a gateway scope only when it differs from the
// one already stored for that scope, and a failure never rejects into the
// connect path — plus the provider's connected-edge call site by source.

import { Platform } from 'react-native';

import * as Notifications from 'expo-notifications';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';

import { syncPushRegistration } from '@/lib/notifications/push-registration';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
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

/** The per-scope key the sync folds against. */
const TOKEN_KEY = 'versutus:expo-push-token:v1';
const scopeKey = (id: string) => `versutus:push-registered:${id}`;

const mockGet = secureKeyValueStorage.getItem as jest.Mock;
const mockSet = secureKeyValueStorage.setItem as jest.Mock;
const mockPermissions = Notifications.getPermissionsAsync as jest.Mock;
const mockToken = Notifications.getExpoPushTokenAsync as jest.Mock;

function rpcStub(): { rpcRequest: jest.Mock } {
  return { rpcRequest: jest.fn().mockResolvedValue({}) };
}

describe('the connected-edge push registration fold', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reads answer per key, the way the real store does.
    mockGet.mockImplementation((key: string) =>
      Promise.resolve(key === TOKEN_KEY ? 'ExponentPushToken[new]' : null),
    );
    mockSet.mockResolvedValue(undefined);
    mockPermissions.mockResolvedValue({ granted: true });
    mockToken.mockResolvedValue({ data: 'ExponentPushToken[new]' });
  });

  test('a scope with no stored token registers the obtained one and records it', async () => {
    const rpc = rpcStub();

    await syncPushRegistration(rpc, 'gateway-a');

    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.register',
      expect.objectContaining({ expoPushToken: 'ExponentPushToken[new]' }),
    );
    expect(mockSet).toHaveBeenCalledWith(scopeKey('gateway-a'), 'ExponentPushToken[new]');
  });

  test('an unchanged token is not registered again for that gateway', async () => {
    mockGet.mockImplementation((key: string) =>
      Promise.resolve(key === scopeKey('gateway-a') ? 'ExponentPushToken[new]' : null),
    );
    const rpc = rpcStub();

    await syncPushRegistration(rpc, 'gateway-a');

    expect(rpc.rpcRequest).not.toHaveBeenCalled();
  });

  test('a rotated token is registered and the scope record replaced', async () => {
    mockGet.mockImplementation((key: string) =>
      Promise.resolve(key === scopeKey('gateway-a') ? 'ExponentPushToken[old]' : null),
    );
    const rpc = rpcStub();

    await syncPushRegistration(rpc, 'gateway-a');

    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.register',
      expect.objectContaining({ expoPushToken: 'ExponentPushToken[new]' }),
    );
    expect(mockSet).toHaveBeenCalledWith(scopeKey('gateway-a'), 'ExponentPushToken[new]');
  });

  test('another gateway gets the token even when this device already stored it elsewhere', async () => {
    // The device-level store holds the token (obtainExpoPushToken's write);
    // gateway-b has never seen a registration.
    mockGet.mockImplementation((key: string) =>
      Promise.resolve(key === TOKEN_KEY ? 'ExponentPushToken[new]' : null),
    );
    const rpc = rpcStub();

    await syncPushRegistration(rpc, 'gateway-b');

    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.register',
      expect.objectContaining({ expoPushToken: 'ExponentPushToken[new]' }),
    );
  });

  test('a register throw resolves without ever rejecting into the connect path', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockRejectedValue(new Error('gate refused'));

    // A refusal is swallowed: the connect edge that fired this must not see it.
    await expect(syncPushRegistration(rpc, 'gateway-a')).resolves.toBeUndefined();
  });

  test('a token failure resolves without touching the gate', async () => {
    mockPermissions.mockResolvedValue({ granted: false });
    const rpc = rpcStub();

    await expect(syncPushRegistration(rpc, 'gateway-a')).resolves.toBeUndefined();
    expect(rpc.rpcRequest).not.toHaveBeenCalled();
  });

  test('web asks the gate nothing', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const rpc = rpcStub();

    await expect(syncPushRegistration(rpc, 'gateway-a')).resolves.toBeUndefined();
    expect(rpc.rpcRequest).not.toHaveBeenCalled();
  });
});

describe('the provider registers on the connected edge', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');

  test('the connected edge holds a push-registration call beside the routine re-arm', () => {
    const src = provider();
    const rearmIdx = src.indexOf('void rearmRoutineNotices()');
    const pushIdx = src.indexOf('void syncPushTokenRegistration()');
    expect(rearmIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(rearmIdx);
  });

  test('the registration effect gates on the connected status and stays fire-and-forget', () => {
    const src = provider();
    const effectStart = src.indexOf("if (status !== 'connected') return;\n    // Fire-and-forget: the connection must never wait on a notification read.");
    const effect = src.slice(effectStart, src.indexOf('const cron = useMemo'));
    expect(effect).toContain("status !== 'connected'");
    expect(effect).toMatch(/void syncPushTokenRegistration\(\)/);
    // The connect effect itself never awaits the sync — it hands the promise
    // to void, exactly like the routine re-arm beside it, which this slice
    // also pins as untouched context.
    expect(effect).toMatch(/void rearmRoutineNotices\(\)/);
    expect(effect).not.toMatch(/await syncPushTokenRegistration/);
  });
});

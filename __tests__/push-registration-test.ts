// ─── Push registration with the Gate (Solution A2) ─────────────────────────
// The app obtains an Expo push token and hands it to the Gate's paired-device
// RPC. Everything native — expo-notifications, expo-constants, SecureStore — is
// mocked here: unit tests never call the real Expo API (the plan says the
// credentials and the native build are operator-held), and the only seam under
// test is what the app asks the Gate for and when.

import { Platform } from 'react-native';

import * as Notifications from 'expo-notifications';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';
import { loadOrCreateDeviceIdentity } from '@/lib/gateway/device-identity';

import {
  deregisterWithGate,
  loadStoredExpoPushToken,
  obtainExpoPushToken,
  registerWithGate,
  syncPushRegistration,
} from '@/lib/notifications/push-registration';

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

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(),
}));

const mockIdentity = loadOrCreateDeviceIdentity as jest.Mock;
const DEVICE_ID = 'a'.repeat(64);

const STORE_KEY = 'versutus:expo-push-token:v1';

const mockGet = secureKeyValueStorage.getItem as jest.Mock;
const mockSet = secureKeyValueStorage.setItem as jest.Mock;
const mockPermissions = Notifications.getPermissionsAsync as jest.Mock;
const mockToken = Notifications.getExpoPushTokenAsync as jest.Mock;

/** The `client.rpcRequest` seam the registration functions take. */
function rpcStub(): { rpcRequest: jest.Mock } {
  return { rpcRequest: jest.fn().mockResolvedValue({}) };
}

describe('push registration', () => {
  beforeEach(() => {
    mockIdentity.mockResolvedValue({ deviceId: DEVICE_ID });
    jest.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue(undefined);
    mockPermissions.mockResolvedValue({ granted: true });
    mockToken.mockResolvedValue({ data: 'ExponentPushToken[new]' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('registerWithGate posts the token, platform and timezone', async () => {
    const rpc = rpcStub();

    await registerWithGate(rpc, 'ExponentPushToken[abc]');

    expect(rpc.rpcRequest).toHaveBeenCalledWith('notifications.register', {
      expoPushToken: 'ExponentPushToken[abc]',
      platform: Platform.OS,
      timezone: expect.any(String),
      // The Gate lets a bootstrap-token phone register only under its own
      // device id; without it every registration was refused (2026-09-16).
      deviceId: DEVICE_ID,
    });
  });

  test('deregistering names the same device', async () => {
    const rpc = rpcStub();
    await deregisterWithGate(rpc);
    expect(rpc.rpcRequest).toHaveBeenCalledWith('notifications.deregister', { deviceId: DEVICE_ID });
  });

  test('an unreadable device identity does not register as an anonymous guest', async () => {
    mockIdentity.mockRejectedValueOnce(new Error('secure store unavailable'));
    const rpc = rpcStub();
    await expect(registerWithGate(rpc, 'ExponentPushToken[abc]')).rejects.toThrow(/device identity/i);
    expect(rpc.rpcRequest).not.toHaveBeenCalled();
  });

  test('a connect-time sync still resolves when identity cannot be made', async () => {
    mockIdentity.mockRejectedValue(new Error('secure store unavailable'));
    const rpc = rpcStub();
    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();
    expect(rpc.rpcRequest).not.toHaveBeenCalled();
  });

  test('a rotated token is written to secure storage, then registered', async () => {
    mockGet.mockResolvedValue('ExponentPushToken[old]');
    const rpc = rpcStub();

    await syncPushRegistration(rpc);

    expect(mockSet).toHaveBeenCalledWith(STORE_KEY, 'ExponentPushToken[new]');
    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.register',
      expect.objectContaining({ expoPushToken: 'ExponentPushToken[new]' }),
    );
  });

  test('an unchanged token is registered without a redundant write', async () => {
    mockGet.mockResolvedValue('ExponentPushToken[new]');
    const rpc = rpcStub();

    await syncPushRegistration(rpc);

    expect(mockSet).not.toHaveBeenCalled();
    expect(rpc.rpcRequest).toHaveBeenCalled();
  });

  test('web returns null and never touches Expo or the gate', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const rpc = rpcStub();

    await expect(obtainExpoPushToken()).resolves.toBeNull();
    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();

    expect(mockToken).not.toHaveBeenCalled();
    expect(rpc.rpcRequest).not.toHaveBeenCalled();
  });

  test('a device without notification permission gets no token', async () => {
    mockPermissions.mockResolvedValue({ granted: false, status: 'undetermined' });

    await expect(obtainExpoPushToken()).resolves.toBeNull();

    expect(mockToken).not.toHaveBeenCalled();
  });

  test('revoked permission deregisters this device even without a locally stored token', async () => {
    mockPermissions.mockResolvedValue({ granted: false, status: 'denied' });
    const rpc = rpcStub();

    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();

    expect(rpc.rpcRequest).toHaveBeenCalledTimes(1);
    expect(rpc.rpcRequest).toHaveBeenCalledWith('notifications.deregister', { deviceId: DEVICE_ID });
    expect(mockToken).not.toHaveBeenCalled();
  });

  test('an undecided permission preserves the existing registration', async () => {
    mockPermissions.mockResolvedValue({ granted: false, status: 'undetermined' });
    const rpc = rpcStub();

    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();

    expect(rpc.rpcRequest).not.toHaveBeenCalled();
    expect(mockToken).not.toHaveBeenCalled();
  });

  test('granting permission after revocation registers the fresh token', async () => {
    const rpc = rpcStub();
    mockPermissions.mockResolvedValueOnce({ granted: false, status: 'denied' });
    await syncPushRegistration(rpc);
    await syncPushRegistration(rpc);

    expect(rpc.rpcRequest).toHaveBeenNthCalledWith(1, 'notifications.deregister', { deviceId: DEVICE_ID });
    expect(rpc.rpcRequest).toHaveBeenNthCalledWith(2, 'notifications.register',
      expect.objectContaining({ deviceId: DEVICE_ID, expoPushToken: 'ExponentPushToken[new]' }));
  });

  test('a refused deregistration never rejects connect and is retried at the next sync', async () => {
    mockPermissions.mockResolvedValue({ granted: false, status: 'denied' });
    const rpc = rpcStub();
    rpc.rpcRequest.mockRejectedValueOnce(new Error('offline'));

    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();
    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();

    expect(rpc.rpcRequest).toHaveBeenCalledTimes(2);
    expect(rpc.rpcRequest).toHaveBeenLastCalledWith('notifications.deregister', { deviceId: DEVICE_ID });
  });

  test('an unreadable permission does not deregister an existing device', async () => {
    mockPermissions.mockRejectedValueOnce(new Error('native module unavailable'));
    const rpc = rpcStub();

    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();

    expect(rpc.rpcRequest).not.toHaveBeenCalled();
    expect(mockToken).not.toHaveBeenCalled();
  });

  test('a temporary token failure does not deregister an existing device', async () => {
    mockToken.mockRejectedValueOnce(new Error('Expo unavailable'));
    const rpc = rpcStub();

    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();

    expect(rpc.rpcRequest).not.toHaveBeenCalled();
  });

  test('a getExpoPushTokenAsync throw resolves null, never thrown to connect', async () => {
    mockToken.mockRejectedValue(new Error('no native module'));

    await expect(obtainExpoPushToken()).resolves.toBeNull();
    await expect(syncPushRegistration(rpcStub())).resolves.toBeUndefined();
  });

  test('a refused register RPC never rejects the connect path', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockRejectedValue(new Error('pairing_required'));

    await expect(syncPushRegistration(rpc)).resolves.toBeUndefined();
    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.register',
      expect.objectContaining({ expoPushToken: 'ExponentPushToken[new]' }),
    );
  });

  test('deregisterWithGate calls notifications.deregister', async () => {
    const rpc = rpcStub();

    await deregisterWithGate(rpc);

    expect(rpc.rpcRequest).toHaveBeenCalledWith('notifications.deregister', { deviceId: DEVICE_ID });
  });

  test('loadStoredExpoPushToken reads the persisted key', async () => {
    mockGet.mockResolvedValue('ExponentPushToken[stored]');

    await expect(loadStoredExpoPushToken()).resolves.toBe('ExponentPushToken[stored]');
    expect(mockGet).toHaveBeenCalledWith(STORE_KEY);
  });
});

describe('every notification call a bootstrap-token phone makes names its device', () => {
  test('the preferences hook sends the device id on get, set and test', () => {
    const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
    const path = jest.requireActual('path') as { join(...parts: string[]): string };
    const hook = nodeFs.readFileSync(path.join(__dirname, '..', 'src', 'hooks', 'use-notification-preferences.ts'), 'utf8');
    expect(hook).toContain("const params = await pushDeviceParams();");
    expect(hook).toContain("'notifications.preferences.get', params");
    expect(hook).toContain("'notifications.test', params");
    expect(hook).not.toContain("...(await pushDeviceParams())");
    const setCall = hook.slice(hook.indexOf("'notifications.preferences.set'"));
    expect(setCall.slice(0, setCall.indexOf('});'))).toContain('...params');
  });
});

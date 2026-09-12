// ─── Push registration with the Gate (Solution A2) ─────────────────────────
// The app obtains an Expo push token and hands it to the Gate's paired-device
// RPC. Everything native — expo-notifications, expo-constants, SecureStore — is
// mocked here: unit tests never call the real Expo API (the plan says the
// credentials and the native build are operator-held), and the only seam under
// test is what the app asks the Gate for and when.

import { Platform } from 'react-native';

import * as Notifications from 'expo-notifications';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';

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
    });
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
    mockPermissions.mockResolvedValue({ granted: false });

    await expect(obtainExpoPushToken()).resolves.toBeNull();

    expect(mockToken).not.toHaveBeenCalled();
  });

  test('a getExpoPushTokenAsync throw resolves null, never thrown to connect', async () => {
    mockToken.mockRejectedValue(new Error('no native module'));

    await expect(obtainExpoPushToken()).resolves.toBeNull();
    await expect(syncPushRegistration(rpcStub())).resolves.toBeUndefined();
  });

  test('deregisterWithGate calls notifications.deregister', async () => {
    const rpc = rpcStub();

    await deregisterWithGate(rpc);

    expect(rpc.rpcRequest).toHaveBeenCalledWith('notifications.deregister');
  });

  test('loadStoredExpoPushToken reads the persisted key', async () => {
    mockGet.mockResolvedValue('ExponentPushToken[stored]');

    await expect(loadStoredExpoPushToken()).resolves.toBe('ExponentPushToken[stored]');
    expect(mockGet).toHaveBeenCalledWith(STORE_KEY);
  });
});

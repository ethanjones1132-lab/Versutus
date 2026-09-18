// Device identity must work on Hermes, which has no WebCrypto.
//
// @noble/ed25519 v3 defaults sha512Async to crypto.subtle and randomSecretKey
// to crypto.getRandomValues. Neither exists on the phone. These tests delete
// globalThis.crypto to simulate that, then require create/load/sign to succeed
// and require a forced failure to be reported rather than swallowed.

import { loadOrCreateDeviceIdentity, signDevicePayload } from '@/lib/gateway/device-identity';
import { DeviceIdentityError } from '@/lib/gateway/errors';
import { pushDeviceParams } from '@/lib/notifications/push-registration';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';

jest.mock('@/lib/storage/secure-key-value', () => ({
  secureKeyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { easConfig: { projectId: '52545800-300a-4bbc-a2b9-7e412d9c217e' } },
}));

jest.mock(
  'expo-crypto',
  () => ({
    getRandomBytes: jest.fn(() => new Uint8Array(32).fill(7)),
  }),
  { virtual: true },
);

const mockGet = secureKeyValueStorage.getItem as jest.Mock;
const mockSet = secureKeyValueStorage.setItem as jest.Mock;

const IDENTITY_KEY = 'versutus:device-identity';

describe('device identity without WebCrypto (Hermes)', () => {
  const backing = new Map<string, string>();
  let originalCrypto: Crypto | undefined;

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
    originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(globalThis.crypto).toBeUndefined();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      configurable: true,
      writable: true,
    });
  });

  test('creates an identity when globalThis.crypto is missing', async () => {
    const identity = await loadOrCreateDeviceIdentity();
    expect(identity.version).toBe(1);
    expect(identity.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.publicKeyB64Url.length).toBeGreaterThan(0);
    expect(identity.privateKeyB64Url.length).toBeGreaterThan(0);
    expect(mockSet).toHaveBeenCalledWith(IDENTITY_KEY, expect.any(String));
  });

  test('the same stored identity loads with a stable deviceId', async () => {
    const first = await loadOrCreateDeviceIdentity();
    const second = await loadOrCreateDeviceIdentity();
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKeyB64Url).toBe(first.publicKeyB64Url);
    expect(second.privateKeyB64Url).toBe(first.privateKeyB64Url);
  });

  test('pushDeviceParams returns that deviceId instead of an empty object', async () => {
    const identity = await loadOrCreateDeviceIdentity();
    await expect(pushDeviceParams()).resolves.toEqual({ deviceId: identity.deviceId });
  });

  test('a stored identity still signs without WebCrypto', async () => {
    const identity = await loadOrCreateDeviceIdentity();
    const signature = await signDevicePayload(identity, 'hello gate');
    expect(signature.length).toBeGreaterThan(0);
    expect(signature).not.toMatch(/[+/=]/);
  });
});

describe('a phone that cannot make an identity says so', () => {
  beforeEach(() => {
    mockGet.mockReset().mockRejectedValue(new Error('secure store unavailable'));
    mockSet.mockReset().mockRejectedValue(new Error('secure store unavailable'));
  });

  test('pushDeviceParams throws a humanized identity error instead of returning {}', async () => {
    await expect(pushDeviceParams()).rejects.toThrow(/device identity/i);
    await expect(pushDeviceParams()).rejects.toThrow(/unpaired guest|cannot tell it from/i);
  });

  test('the thrown error is not the raw storage exception', async () => {
    try {
      await pushDeviceParams();
      throw new Error('expected pushDeviceParams to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceIdentityError);
      expect((err as Error).message).not.toMatch(/secure store unavailable/);
      expect((err as Error).name).toBe('DeviceIdentityError');
    }
  });
});

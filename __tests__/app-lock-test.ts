jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

// The native bridge is mocked as the repo's notification suites mock
// expo-notifications: the module owns the platform call, the suite owns the
// device the call reports.
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';

import {
  APP_LOCK_STORAGE_KEY,
  appLockFromStored,
  appLockUnavailableCopy,
  appLockUnavailableReason,
  loadAppLock,
  saveAppLock,
} from '@/lib/settings/app-lock';
import { deviceAppLockState } from '@/lib/settings/app-lock-device';

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

const layout = () => readSource('src', 'app', '_layout.tsx');
const gate = () => readSource('src', 'components', 'app-lock-gate.tsx');
const settingsScreen = () => readSource('src', 'app', 'gateway', 'settings.tsx');

const mockGetItem = AsyncStorage.getItem as jest.Mock;
const mockSetItem = AsyncStorage.setItem as jest.Mock;
const mockHasHardware = LocalAuthentication.hasHardwareAsync as jest.Mock;
const mockIsEnrolled = LocalAuthentication.isEnrolledAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetItem.mockResolvedValue(null);
  mockHasHardware.mockResolvedValue(true);
  mockIsEnrolled.mockResolvedValue(true);
});

describe('appLockFromStored', () => {
  test('a stored true is the one value that turns the lock on', () => {
    expect(appLockFromStored(true)).toBe(true);
  });

  test('no stored value is off — the lock is opt-in', () => {
    expect(appLockFromStored(undefined)).toBe(false);
    expect(appLockFromStored(null)).toBe(false);
  });

  test('a stored false is off', () => {
    expect(appLockFromStored(false)).toBe(false);
  });

  test('truthy-but-not-true is off, never guessed into on', () => {
    expect(appLockFromStored('true')).toBe(false);
    expect(appLockFromStored(1)).toBe(false);
    expect(appLockFromStored({})).toBe(false);
  });

  test('a corrupt blob value reads as off', () => {
    expect(appLockFromStored('not-json')).toBe(false);
  });
});

describe('appLockUnavailableReason', () => {
  test('no hardware at all is the reason', () => {
    expect(appLockUnavailableReason(false, false)).toBe('unsupported');
    expect(appLockUnavailableReason(false, true)).toBe('unsupported');
  });

  test('hardware with nothing enrolled is its own reason', () => {
    expect(appLockUnavailableReason(true, false)).toBe('not-enrolled');
  });

  test('hardware with an enrollment can answer', () => {
    expect(appLockUnavailableReason(true, true)).toBeNull();
  });
});

describe('appLockUnavailableCopy', () => {
  test('each reason has its own line', () => {
    expect(appLockUnavailableCopy('unsupported')).not.toBe(appLockUnavailableCopy('not-enrolled'));
  });

  test('neither line pretends the lock is on', () => {
    for (const reason of ['unsupported', 'not-enrolled'] as const) {
      expect(appLockUnavailableCopy(reason)).not.toMatch(/locked|lock is on/i);
    }
  });
});

describe('the stored flag', () => {
  test('turning it on writes one boolean under the app-lock key', async () => {
    await saveAppLock(true);
    expect(mockSetItem).toHaveBeenCalledWith(APP_LOCK_STORAGE_KEY, 'true');
  });

  test('turning it off writes the same key, not a delete', async () => {
    await saveAppLock(false);
    expect(mockSetItem).toHaveBeenCalledWith(APP_LOCK_STORAGE_KEY, 'false');
  });

  test('a device that never opted in reads off', async () => {
    expect(await loadAppLock()).toBe(false);
  });

  test('a stored true reads back on', async () => {
    mockGetItem.mockResolvedValueOnce('true');
    expect(await loadAppLock()).toBe(true);
  });

  test('a truncated write reads off rather than throwing', async () => {
    mockGetItem.mockResolvedValueOnce('{"appLock":');
    expect(await loadAppLock()).toBe(false);
  });
});

describe('deviceAppLockState', () => {
  test('a device that never opted in is not locked, whatever it can do', async () => {
    mockGetItem.mockResolvedValueOnce('false');
    expect(await deviceAppLockState()).toEqual({ enabled: false, reason: null });
  });

  test('the flag plus an enrolled device is a lock', async () => {
    mockGetItem.mockResolvedValueOnce('true');
    expect(await deviceAppLockState()).toEqual({ enabled: true, reason: null });
  });

  test('an enrollment removed after the flag was stored unlocks', async () => {
    mockGetItem.mockResolvedValueOnce('true');
    mockIsEnrolled.mockResolvedValueOnce(false);
    expect(await deviceAppLockState()).toEqual({ enabled: true, reason: 'not-enrolled' });
  });

  test('a platform that cannot answer the question never locks', async () => {
    mockGetItem.mockResolvedValueOnce('true');
    mockHasHardware.mockRejectedValueOnce(new Error('UnavailabilityError'));
    expect(await deviceAppLockState()).toEqual({ enabled: true, reason: 'unsupported' });
  });
});

describe('the gate and its switch', () => {
  test('the lock gate wraps the Stack inside the boot gate', () => {
    const src = layout();
    const gate = src.indexOf('<AppLockGate>');
    expect(gate).toBeGreaterThan(src.indexOf('<AppBootstrap>'));
    expect(gate).toBeLessThan(src.indexOf('<Stack'));
    expect(src).toContain("import { AppLockGate } from '@/components/app-lock-gate';");
  });

  test('the cover sits over the app rather than replacing it', () => {
    const src = gate();
    // The Stack keeps rendering behind an opaque cover: unmounting it would
    // cost the router, the deep-link listeners and the notification router.
    expect(src).toContain('{children}');
    expect(src).toMatch(/\{locked \? \(/);
    expect(src).toMatch(/position: 'absolute'/);
  });

  test('the gate asks the device through the module, never itself', () => {
    const src = gate();
    expect(src).toContain('deviceAppLockState');
    expect(src).toContain('authenticateAsync');
    // No gateway call and no second store: this is a device lock, not a
    // gateway feature, and a kick to the gateway on every open would be one.
    expect(src).not.toContain('useGateway');
    expect(src).not.toContain('keyValueStorage');
  });

  test('the gate relocks when the app is backgrounded, not when it is interrupted', () => {
    const src = gate();
    expect(src).toMatch(/state === 'background'/);
    expect(src).not.toMatch(/state !== 'active'/);
  });

  test('the settings screen shows the switch only where the device can answer', () => {
    const src = settingsScreen();
    expect(src).toContain('deviceAppLockState');
    expect(src).toContain('appLockUnavailableCopy');
    expect(src).toContain('saveAppLock');
    // The reason line and the switch are one branch: a device that cannot
    // answer never renders a control that could not finish.
    expect(src).toMatch(/\{appLockReason \? \(/);
  });

  test('the lock copy never claims the gateway did anything', () => {
    const src = gate();
    expect(src).not.toMatch(/gateway (is )?(locked|secure)/i);
  });

  test('iOS is told why Face ID is being asked for', () => {
    // Without this key expo-local-authentication falls back to the device
    // passcode on a Face ID iPhone (v57 docs), which the summary's "Face ID or
    // your fingerprint" line would then be claiming wrongly.
    const app = readSource('app.json');
    expect(app).toContain('NSFaceIDUsageDescription');
  });
});

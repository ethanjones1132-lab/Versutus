// ─── The App-lock switch takes effect without a cold start ───────────────────
// The gate asked the device ONCE, in a mount-only effect, and kept the answer in
// a ref the AppState listener only read. So turning the lock on in Settings and
// pressing Home came back with no cover, and turning it off left the app locked
// — a security control inert in both directions for the rest of the process's
// life. These cases drive the real gate, the real opt-in writer and the real
// device probe: the switch is flipped AFTER mount, with no remount.

jest.mock('@/lib/storage/key-value', () => {
  const store = new Map<string, string>();
  return {
    keyValueStorage: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
    },
  };
});

const storage = jest.requireMock('@/lib/storage/key-value') as {
  keyValueStorage: { setItem: jest.Mock };
};
const APP_LOCK_KEY = 'versutus:app-lock';

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

// The device seam answers for real, except where a case needs the read itself to
// fail: `loadAppLock` swallows a bad blob, so the only way to reach the gate's
// own "a verdict that cannot be read" branch is to refuse the question.
const deviceFault = { unreadable: false };
jest.mock('@/lib/settings/app-lock-device', () => {
  const actual = jest.requireActual('@/lib/settings/app-lock-device') as {
    deviceAppLockState: () => Promise<{ enabled: boolean; reason: string | null }>;
  };
  return {
    ...actual,
    deviceAppLockState: jest.fn(async () => {
      if (deviceFault.unreadable) throw new Error('the keychain is locked');
      return actual.deviceAppLockState();
    }),
  };
});

jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Button: 'Button',
  Divider: 'Divider',
  Text: 'Text',
}));

jest.mock('@/components/brand/versutus-mark', () => ({ VersutusMark: 'VersutusMark' }));

// The TLS prompt is real; only the gateway that raises it and its controls are
// supplied here, so the guard's own visibility rule is what the case observes.
jest.mock('@/context/gateway-provider', () => ({
  useGateway: jest.fn(),
}));

jest.mock('@/lib/haptics', () => ({
  haptics: {
    warning: jest.fn(async () => undefined),
    success: jest.fn(async () => undefined),
  },
}));

// tokens.ts only needs Easing for its Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    canDismiss: () => false,
    canGoBack: () => true,
    dismissAll: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
  }),
  usePathname: () => '/chat',
  useGlobalSearchParams: () => ({}),
}));

import { createElement, type ElementType } from 'react';
import { AppState, type AppStateStatus, Modal } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { AppLockGate } from '@/components/app-lock-gate';
import { TlsFingerprintGuard } from '@/components/gateway/tls-fingerprint-guard';
import { saveAppLock } from '@/lib/settings/app-lock';
import { deviceAppLockState } from '@/lib/settings/app-lock-device';

// Stand-in host name for the mocked Button; not a real JSX intrinsic, so it
// needs the ElementType cast the way the glass-surface test does.
const BUTTON = 'Button' as ElementType;
const mockDeviceState = deviceAppLockState as jest.MockedFunction<typeof deviceAppLockState>;
const gatewayMock = jest.requireMock('@/context/gateway-provider') as {
  useGateway: jest.Mock;
};
const biometric = jest.requireMock('expo-local-authentication') as {
  authenticateAsync: jest.Mock;
};

type TlsPrompt = {
  previousFingerprint: string;
  observedFingerprint: string;
  gatewayId: string;
  gatewayName: string;
};
const mockTlsPrompt: { current: TlsPrompt | null } = { current: null };
const mockApproveTls = jest.fn(async () => undefined);
const mockRejectTls = jest.fn();

let renderer: ReactTestRenderer;
let appStateListeners: ((state: AppStateStatus) => void)[] = [];

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(AppLockGate, null, createElement('App', null)));
  });
}

/** The real guard mounted under the real gate, for the lock's TLS contract. */
async function mountWithTls(): Promise<void> {
  await act(async () => {
    renderer = create(
      createElement(AppLockGate, null, createElement(TlsFingerprintGuard)),
    );
  });
}

/** Whether the cover is up. The gate draws it on the one answer that means locked. */
function covered(): boolean {
  return renderer.root.findByType(Modal).props.visible === true;
}

/** The Settings screen's own write, and the notification it wakes the gate with. */
async function flipTheSwitch(enabled: boolean): Promise<void> {
  await act(async () => {
    await saveAppLock(enabled);
  });
}

async function appState(state: AppStateStatus): Promise<void> {
  await act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
  });
}

async function background(): Promise<void> {
  await appState('background');
}

async function unlock(): Promise<void> {
  const button = renderer.root
    .findAllByType(BUTTON)
    .find((candidate) => candidate.props.label === 'Unlock');
  expect(button).toBeDefined();
  await act(async () => {
    button?.props.onPress();
  });
}

/** The Trust control the TLS prompt offers, if it is on screen at all. */
function trustButton() {
  return renderer.root
    .findAllByType(BUTTON)
    .find((candidate) => candidate.props.label === 'Trust new fingerprint');
}

/** Every string on screen, so a fingerprint cannot hide in a child. */
function screenText(): string {
  return renderer.root
    .findAll(() => true)
    .flatMap((node) => {
      const children = node.props?.children;
      if (typeof children === 'string' || typeof children === 'number') return [String(children)];
      if (Array.isArray(children)) {
        return children
          .filter((child) => typeof child === 'string' || typeof child === 'number')
          .map(String);
      }
      return [];
    })
    .join('\n');
}

beforeEach(() => {
  appStateListeners = [];
  deviceFault.unreadable = false;
  mockTlsPrompt.current = null;
  gatewayMock.useGateway.mockImplementation(() => ({
    tlsFingerprintChange: mockTlsPrompt.current,
    approveTlsFingerprintChange: mockApproveTls,
    rejectTlsFingerprintChange: mockRejectTls,
  }));
  biometric.authenticateAsync.mockReset();
  biometric.authenticateAsync.mockImplementation(async () => ({ success: true }));
  storage.keyValueStorage.setItem.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    listener: (state: AppStateStatus) => void,
  ) => {
    appStateListeners.push(listener);
    return {
      remove: () => {
        const at = appStateListeners.indexOf(listener);
        if (at >= 0) appStateListeners.splice(at, 1);
      },
    };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.restoreAllMocks();
  await storage.keyValueStorage.setItem(APP_LOCK_KEY, 'false');
});

describe('the app-lock switch reaches the gate it is behind', () => {
  test('turning the lock on covers the app on the next leave, without a cold start', async () => {
    await saveAppLock(false);
    await mount();
    expect(covered()).toBe(false);

    // The operator is IN Settings with work in hand, so the cover does not go up
    // under them — the background edge is the one that locks.
    await flipTheSwitch(true);
    expect(covered()).toBe(false);

    await background();
    expect(covered()).toBe(true);
  });

  test('turning the lock off stops the next leave from covering, without a cold start', async () => {
    // A cold start with the lock on: the gate locks before the operator arrives,
    // which is the one path that already worked.
    await saveAppLock(true);
    await mount();
    expect(covered()).toBe(true);
    await unlock();
    expect(covered()).toBe(false);

    await flipTheSwitch(false);
    await background();

    // Still open. With a verdict read once at mount this cover comes back, and
    // the switch the operator just turned off is the one lying.
    expect(covered()).toBe(false);
  });

  test('the write is observed, not just stored: the gate re-asks the device', async () => {
    await saveAppLock(false);
    await mount();
    const readsAtMount = mockDeviceState.mock.calls.length;

    await flipTheSwitch(true);

    expect(storage.keyValueStorage.setItem).toHaveBeenCalledWith(APP_LOCK_KEY, 'true');
    expect(mockDeviceState.mock.calls.length).toBeGreaterThan(readsAtMount);
  });

  test('an unsubscribed gate stops hearing the switch', async () => {
    await saveAppLock(false);
    await mount();
    const readsAtMount = mockDeviceState.mock.calls.length;

    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
    await act(async () => {
      await saveAppLock(true);
    });

    expect(mockDeviceState.mock.calls.length).toBe(readsAtMount);
  });
});

describe('a verdict this phone cannot give', () => {
  test('a read that throws keeps the previous one and never locks an open device', async () => {
    await saveAppLock(false);
    await mount();
    expect(covered()).toBe(false);

    deviceFault.unreadable = true;
    await flipTheSwitch(true);
    await background();

    // The store says on, the device could not say, so the app stays reachable
    // rather than sealing the operator out on an error.
    expect(covered()).toBe(false);
  });
});

describe('the lock keeps a security prompt off the device it covers', () => {
  test('a locked gate presents no TLS Trust control or fingerprints, and the unlock reveals the same prompt', async () => {
    await saveAppLock(true);
    mockTlsPrompt.current = {
      previousFingerprint: 'AA11',
      observedFingerprint: 'BB22',
      gatewayId: 'alpha',
      gatewayName: 'alpha',
    };
    await mountWithTls();

    expect(covered()).toBe(true);
    // Nothing of the change prompt may be reachable or legible over the cover:
    // not the Trust control, not either fingerprint.
    expect(trustButton()).toBeUndefined();
    expect(screenText()).not.toContain('AA11');
    expect(screenText()).not.toContain('BB22');

    // The prompt was held, not dropped: the unlock shows the same change.
    await unlock();
    expect(covered()).toBe(false);
    expect(trustButton()).toBeDefined();
    expect(screenText()).toContain('AA11');
    expect(screenText()).toContain('BB22');
  });

  test('an inactive edge covers the app and an active return to an open gate clears it', async () => {
    await saveAppLock(false);
    await mount();
    expect(covered()).toBe(false);

    // The edge iOS takes the app-switcher snapshot on: the cover must be up
    // even though the lock itself is off, so the snapshot shows no content.
    await appState('inactive');
    expect(covered()).toBe(true);

    await appState('active');
    expect(covered()).toBe(false);
  });

  test('a prompt inactive edge during an unlock does not relock over its success', async () => {
    await saveAppLock(true);
    let settleUnlock: (result: { success: boolean }) => void = () => undefined;
    biometric.authenticateAsync.mockImplementationOnce(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          settleUnlock = resolve;
        }),
    );
    await mount();
    expect(covered()).toBe(true);

    await unlock();
    // The biometric prompt itself takes the app inactive while it decides.
    await appState('inactive');
    expect(covered()).toBe(true);
    await appState('active');
    // That 'active' is the prompt closing, not the operator returning, so the
    // cover waits for the unlock's answer instead of lifting early.
    expect(covered()).toBe(true);

    await act(async () => {
      settleUnlock({ success: true });
    });
    expect(covered()).toBe(false);

    // A later system prompt over the now-open app covers it for its snapshot...
    await appState('inactive');
    expect(covered()).toBe(true);
    // ... and the return lifts that cover without relocking the app.
    await appState('active');
    expect(covered()).toBe(false);
    expect(biometric.authenticateAsync).toHaveBeenCalledTimes(1);
  });
});

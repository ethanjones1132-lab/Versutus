// ─── The lock's fail-closed paths are pinned ───────────────────────
// VS-015 (QUALITY-SCAN-2026-10-11 lines 107-112): the 2026-10-11 fixes made a
// refused flag read hold the cover, but nothing pins the behaviour, so a public
// build could silently reopen. These cases drive the REAL gate, the REAL device
// seam and the REAL opt-in rules; the mocks sit only at the module boundary —
// `@/lib/storage/key-value` (the stored opt-in blob) and `expo-local-authentication`
// (the device credential APIs, v57) — and nothing here mocks the gate itself
// open: every assertion reads the cover the gate decided to draw on its own.
//
// The gate's own shape is worth restating, because "no protected child
// rendered" has one honest reading here: the gate draws the cover OVER the app
// rather than replacing it (app-lock-gate.tsx:3-5) — the Stack stays mounted so
// the router keeps working, and what the fail-closed rule guarantees is that
// the cover is up whenever the device's answer does not say `open`, with no
// fade for content to peek through and no `open` settle from a bad answer.

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

// tokens.ts only needs Easing for its Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Text: 'Text',
}));

jest.mock('@/components/brand/versutus-mark', () => ({ VersutusMark: 'VersutusMark' }));

// The router owns the one factory state the pending case needs to read back:
// the fns live in the factory closure, so each test reaches them through
// `requireMock` and mutates nothing out of scope.
jest.mock('expo-router', () => {
  const canDismiss = jest.fn(() => false);
  const dismissAll = jest.fn();
  const push = jest.fn();
  return {
    canDismiss,
    dismissAll,
    push,
    useRouter: () => ({
      canDismiss,
      canGoBack: () => true,
      dismissAll,
      push,
      back: jest.fn(),
      replace: jest.fn(),
    }),
    usePathname: () => '/chat',
    useGlobalSearchParams: () => ({}),
  };
});

import { createElement, useEffect, type ElementType } from 'react';
import { AppState, type AppStateStatus, Modal } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { AppLockGate } from '@/components/app-lock-gate';
import { saveAppLock } from '@/lib/settings/app-lock';
import { deviceAppLockState } from '@/lib/settings/app-lock-device';

// Stand-in host name for the mocked Button; not a real JSX intrinsic, so it
// needs the ElementType cast the way the glass-surface test does.
const BUTTON = 'Button' as ElementType;

const storage = (
  jest.requireMock('@/lib/storage/key-value') as {
    keyValueStorage: { getItem: jest.Mock; setItem: jest.Mock; removeItem: jest.Mock };
  }
).keyValueStorage;
const device = jest.requireMock('expo-local-authentication') as {
  hasHardwareAsync: jest.Mock;
  isEnrolledAsync: jest.Mock;
  authenticateAsync: jest.Mock;
};
const routerMocks = jest.requireMock('expo-router') as {
  canDismiss: jest.Mock;
  dismissAll: jest.Mock;
  push: jest.Mock;
};

// The protected surface the gate wraps: everything below counts one stand-in
// for the chats subtree, so a re-mount or a re-render under an unlock or a
// cover edge would show up here instead of hiding.
let protectedRenders = 0;
let protectedUnmounts = 0;

function ProtectedChats() {
  protectedRenders += 1;
  useEffect(() => () => {
    protectedUnmounts += 1;
  }, []);
  return createElement('view', { testID: 'protected-chats' });
}

let renderer: ReactTestRenderer | undefined;
let appStateListeners: ((state: AppStateStatus) => void)[] = [];

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(AppLockGate, null, createElement(ProtectedChats)));
  });
}

/** Whether the cover is up; the gate draws it on the one answer that means locked. */
function covered(): boolean {
  return renderer?.root.findByType(Modal).props.visible === true;
}

/** The cover's own Unlock press, driven through the gate's real handler. */
async function unlock(): Promise<void> {
  const button = renderer?.root
    .findAllByType(BUTTON)
    .find((candidate) => candidate.props.label === 'Unlock');
  expect(button).toBeDefined();
  await act(async () => {
    button?.props.onPress();
  });
}

beforeEach(() => {
  protectedRenders = 0;
  protectedUnmounts = 0;
  appStateListeners = [];
  storage.getItem.mockReset();
  storage.getItem.mockResolvedValue(null);
  device.hasHardwareAsync.mockReset();
  device.hasHardwareAsync.mockResolvedValue(true);
  device.isEnrolledAsync.mockReset();
  device.isEnrolledAsync.mockResolvedValue(true);
  device.authenticateAsync.mockReset();
  device.authenticateAsync.mockResolvedValue({ success: true });
  routerMocks.canDismiss.mockClear();
  routerMocks.canDismiss.mockImplementation(() => false);
  routerMocks.dismissAll.mockClear();
  routerMocks.push.mockClear();
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
    renderer = undefined;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.restoreAllMocks();
});

describe('a verdict the storage read cannot resolve', () => {
  test('a refused read of the flag covers the app before any prompt runs', async () => {
    // The keychain refuses the read: the flag is UNKNOWN, not off — reading it
    // as off is exactly the fail-open the scan called out.
    storage.getItem.mockRejectedValue(new Error('the keychain is locked'));

    await mount();

    // The cover is up over the chats the gate holds mounted: whatever sits
    // under it, nothing of the app settles reachable through an `open` phase.
    expect(covered()).toBe(true);
    // No fade: a transparent cover fading in would leave the chats legible
    // for the length of the animation.
    expect(renderer?.root.findByType(Modal).props.animationType).toBe('none');
    // The verdict came from the store's refusal alone — no credential prompt
    // ran to decide it, so a misbehaving keychain cannot talk the gate open.
    expect(device.authenticateAsync).not.toHaveBeenCalled();

    // The lock holds its own answer across the re-lock edge too.
    await act(async () => {
      for (const listener of [...appStateListeners]) listener('background');
    });
    expect(covered()).toBe(true);
  });

  test('a stored blob that does not parse is a lost answer, not an off one', async () => {
    // A half-written write leaves a blob that neither parses nor reads back as
    // the flag. The verdict cannot say what the operator asked for, so an able
    // device holds the cover — the passcode fallback keeps it from ever being
    // a lockout — and the blob never silently retires the lock the operator
    // chose. (`loadAppLock` keeps the boolean contract for its pinned cases;
    // it is the device seam that owns fail-closed.)
    storage.getItem.mockResolvedValue('{"appLock":');

    await mount();
    expect(covered()).toBe(true);
    expect(await deviceAppLockState()).toEqual({ enabled: true, reason: null });

    // The deliberate contrast, pinned where it already holds: an ABSENT flag
    // is the opt-in rule reading off — the lock is off unless this device was
    // asked to hold it.
    storage.getItem.mockResolvedValue(null);
    expect(await deviceAppLockState()).toEqual({ enabled: false, reason: null });
  });
});

describe('a credential check that cannot answer', () => {
  test('a prompt that cannot run keeps the cover up until the retry unlocks', async () => {
    storage.getItem.mockResolvedValue('true');
    await mount();
    expect(covered()).toBe(true);

    // The first prompt rejects — the module could not ask at all, which is not
    // a success the lock should treat as a pass. The catch leaves the phase
    // alone, so the cover stays exactly where it was.
    device.authenticateAsync.mockRejectedValueOnce(new Error('the prompt could not run'));
    await unlock();
    expect(covered()).toBe(true);

    // The retry is the operator's own way back in, and it still unlocks.
    await unlock();
    expect(covered()).toBe(false);
    expect(device.authenticateAsync).toHaveBeenCalledTimes(2);
  });
});

describe('an answer that has not landed', () => {
  test('the pending window consumes nothing, and the answer holds the cold-start link', async () => {
    // The route an unresolved gate is presented with is the one a cold-start
    // `versutus://add` link can already sit on before the answer lands — the
    // gate must neither consume it nor settle optimistically open.
    let settleFlag: (raw: string) => void = () => undefined;
    storage.getItem.mockReset();
    storage.getItem.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          settleFlag = resolve;
        }),
    );

    await mount();

    // Unresolved is its own phase: no cover drawn from a guess ...
    expect(covered()).toBe(false);
    // ... and nothing disposed of either — no dismissal, no re-open, no
    // accounting that could turn the presented route into the operator's own.
    expect(routerMocks.dismissAll).not.toHaveBeenCalled();
    expect(routerMocks.push).not.toHaveBeenCalled();

    // The answer lands locked: the route that waited through the window is
    // still an arrival, so it is brought down and HELD for the unlock.
    routerMocks.canDismiss.mockReturnValue(true);
    await act(async () => {
      settleFlag('true');
    });
    expect(covered()).toBe(true);
    expect(routerMocks.dismissAll).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).not.toHaveBeenCalled();

    // A gate that had optimistically opened during the window would have
    // accounted the route as the operator's own and never held it — the push
    // that follows the unlock is what separates the pending phase from open.
    await unlock();
    expect(covered()).toBe(false);
    expect(routerMocks.push).toHaveBeenCalledWith('/chat');
  });
});

describe('the unlock and its leftovers', () => {
  test('the unlock renders the chats once and leaves nothing subscribed behind', async () => {
    storage.getItem.mockResolvedValue('true');
    await mount();
    expect(covered()).toBe(true);
    expect(protectedRenders).toBe(1);

    await unlock();
    expect(covered()).toBe(false);
    // The chats mounted once, through pending, covered and open alike: the
    // unlock raised the cover without remounting or re-rendering the subtree.
    expect(protectedRenders).toBe(1);
    expect(routerMocks.push).not.toHaveBeenCalled();

    const readsAtUnlock = device.hasHardwareAsync.mock.calls.length;

    // The whole gate goes down (in the app this is process shutdown), so
    // anything it still held would surface at the edges below — it holds
    // nothing: the child unmounts with it, and the subscriptions are gone.
    const doomed = renderer;
    renderer = undefined;
    await act(async () => {
      doomed?.unmount();
    });
    expect(protectedUnmounts).toBe(1);
    expect(appStateListeners).toHaveLength(0);

    // A Settings write after the gate is gone wakes no listener, so no device
    // re-read is spent on an answer nobody will hold.
    await act(async () => {
      await saveAppLock(false);
    });
    expect(device.hasHardwareAsync.mock.calls.length).toBe(readsAtUnlock);

    // And one full macrotask later nothing has started ticking behind the
    // gate's back either — no settled-aside timer quietly re-reads the device.
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(device.hasHardwareAsync.mock.calls.length).toBe(readsAtUnlock);
  });
});

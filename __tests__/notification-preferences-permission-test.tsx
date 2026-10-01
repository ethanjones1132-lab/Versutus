// ─── What the phone actually says about notifications ─────────────────────
// The card under this switch says permission is asked here and never at launch,
// so the card also has to be able to report the phone's own answer. It could
// not. The answer was read once, on mount, and every non-granted status was
// painted as a refusal — so a fresh install, where the OS reports
// `undetermined` precisely because nobody has ever asked, opened this screen
// claiming the operator had switched notifications off. And a permission revoked
// in Android Settings was never noticed at all: this screen is a plain Stack
// child, so returning to the app does not remount it and the read it did make
// is a cached first answer to a question about the present.
//
// `useState` is wrapped so "no state update after the screen is gone" is
// something this file can see rather than something it has to take on trust.

const mockSetters: jest.Mock[] = [];
jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: unknown) => {
      const [value, setValue] = actual.useState(initial as never);
      // The tracked setter IS the one the hook gets, so a `setState` this file
      // cannot see is a `setState` that did not happen.
      const tracked = jest.fn(setValue);
      mockSetters.push(tracked);
      return [value, tracked];
    },
  };
});

import { createElement, useEffect } from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useNotificationPreferences } from '@/hooks/use-notification-preferences';

const mockRequest = jest.fn();
const mockPermissionRead = jest.fn();
const mockRequestPermission = jest.fn();
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    activeGateway: { kind: 'custom' },
    status: 'connected',
    gatewayRequest: mockRequest,
  }),
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: () => mockPermissionRead(),
  requestPermissionsAsync: () => mockRequestPermission(),
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn().mockResolvedValue({ deviceId: 'test-device' }),
  syncPushRegistration: jest.fn(),
}));

type Answer = { granted: boolean; status: string; canAskAgain: boolean };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The three states expo's `getPermissionsAsync` can answer with. */
const GRANTED: Answer = { granted: true, status: 'granted', canAskAgain: false };
const DENIED: Answer = { granted: false, status: 'denied', canAskAgain: false };
/** A phone nobody has asked: Android 13+ and every first launch on iOS. */
const UNDETERMINED: Answer = { granted: false, status: 'undetermined', canAskAgain: true };

let preferences: ReturnType<typeof useNotificationPreferences>;
function Harness() {
  const current = useNotificationPreferences();
  // Published from an effect, not from render: the tests read it after `act`,
  // which has already flushed both.
  useEffect(() => {
    preferences = current;
  });
  return null;
}

/** What the phone reports right now — a request that grants changes it. */
let phone: Answer;

let renderer: ReactTestRenderer;
let appStateListeners: ((state: string) => void)[];

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
  }
}

/** The app coming back to the foreground, the trip that reaches OS Settings. */
async function foreground(): Promise<void> {
  await act(async () => {
    for (const listener of appStateListeners) listener('active');
  });
  await flush();
}

beforeEach(async () => {
  jest.useFakeTimers();
  mockSetters.length = 0;
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    type: string,
    handler: (state: string) => void,
  ) => {
    if (type === 'change') appStateListeners.push(handler);
    return { remove: () => undefined };
  }) as unknown as typeof AppState.addEventListener);
  phone = GRANTED;
  mockPermissionRead.mockReset().mockImplementation(() => Promise.resolve(phone));
  mockRequestPermission.mockReset().mockImplementation(() => {
    phone = GRANTED;
    return Promise.resolve(GRANTED);
  });
  mockRequest.mockReset().mockImplementation((method: string) =>
    Promise.resolve(method === 'notifications.preferences.set' ? { enabled: true } : {}),
  );
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  await flush();
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a phone nobody has asked is not a refusal', async () => {
  phone = UNDETERMINED;
  await act(async () => {
    renderer.unmount();
    renderer = create(createElement(Harness));
  });
  await flush();

  // `undetermined` collapsed into `denied` here, so this screen opened on a
  // fresh install telling the operator their notifications were switched off.
  expect(preferences.permission).toBe('undetermined');
});

test('a phone that refuses is asked for nothing and told where to look', async () => {
  mockPermissionRead.mockResolvedValue(DENIED);
  await act(async () => {
    renderer.unmount();
    renderer = create(createElement(Harness));
  });
  await flush();
  expect(preferences.permission).toBe('denied');

  await act(async () => {
    await preferences.setEnabled(true);
  });
  await flush();

  // A refused permission has nothing to ask: the dialog would not appear, and
  // asking again spends the one chance the operator still has in Settings.
  expect(mockRequestPermission).not.toHaveBeenCalled();
  expect(preferences.error).toMatch(/system settings/);
  expect(preferences.prefs.enabled).toBe(false);
});

test('a phone that cannot answer at all is neither a grant nor a refusal', async () => {
  mockPermissionRead.mockRejectedValue(new Error('no permission module here'));
  await act(async () => {
    renderer.unmount();
    renderer = create(createElement(Harness));
  });
  await flush();

  expect(preferences.permission).toBe('unknown');
});

test('a phone nobody has asked is asked by the toggle, not told it is off', async () => {
  phone = UNDETERMINED;
  await act(async () => {
    renderer.unmount();
    renderer = create(createElement(Harness));
  });
  await flush();
  expect(preferences.permission).toBe('undetermined');

  await act(async () => {
    await preferences.setEnabled(true);
  });
  await flush();

  expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  // The granted phone keeps saying granted on the read the successful write
  // makes, so the caption does not swing back the moment the Gate answers.
  expect(preferences.permission).toBe('granted');
  expect(preferences.error).toBeNull();
  expect(preferences.prefs.enabled).toBe(true);
  expect(mockRequest).toHaveBeenCalledWith('notifications.preferences.set', {
    enabled: true,
    deviceId: 'test-device',
  });
});

test('a revoke between two foregrounds is what the screen then says', async () => {
  // Granted on arrival — the operator sees a working relay and walks to Android
  // Settings to switch notifications off for Versutus.
  expect(preferences.permission).toBe('granted');

  mockPermissionRead.mockResolvedValue(DENIED);
  await foreground();

  // The screen is a Stack child: returning to the app does not remount it, so
  // without a read on the foreground edge the toggle stayed on and no caption
  // named the refusal.
  expect(mockPermissionRead).toHaveBeenCalledTimes(2);
  expect(preferences.permission).toBe('denied');
});

test('a read that answers after a newer one cannot repaint the newer answer', async () => {
  const slow = deferred<Answer>();
  mockPermissionRead.mockImplementationOnce(() => slow.promise).mockResolvedValue(DENIED);

  await foreground();
  await foreground();
  expect(preferences.permission).toBe('denied');

  // The slow read was asked first, so its answer is the older one, however late
  // it turns up.
  slow.resolve(GRANTED);
  await flush();
  expect(preferences.permission).toBe('denied');
});

test('a screen that is gone stops reading the phone and keeps a late answer', async () => {
  const slow = deferred<Answer>();
  mockPermissionRead.mockImplementationOnce(() => slow.promise);
  await foreground();
  expect(mockPermissionRead).toHaveBeenCalledTimes(2);

  const watched = mockSetters
    .splice(0, mockSetters.length)
    .map((setter) => [setter, setter.mock.calls.length] as const);
  await act(async () => {
    renderer.unmount();
  });

  // An event that arrives after the listener is gone asks nothing: there is no
  // screen left to paint.
  await act(async () => {
    for (const listener of appStateListeners) listener('active');
  });
  await flush();
  expect(mockPermissionRead).toHaveBeenCalledTimes(2);

  // And the read already in flight, when it lands, changes nothing.
  slow.resolve(DENIED);
  await flush();
  expect(watched.filter(([setter, before]) => setter.mock.calls.length > before)).toEqual([]);
});

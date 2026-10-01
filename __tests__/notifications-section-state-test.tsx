// ─── The Notifications card, on the operator's side of the wire ────────────
// The card holds three promises the phone has to keep. The quiet-hours fields
// show what is saved, but what is typed is the operator's until the Gate takes
// it — the hook answers every read and every write with a FRESH row, and a
// field seeded off that row's identity lost whatever was in it to any other
// switch on the same card. The permission caption says what the phone reports
// now: a revoke in Android Settings is reached by leaving the app, which does
// not remount this screen. And the error card tells the operator the switches
// stay locked until the Gate's own settings are read, so a refused write has to
// lock them.
//
// The Gate is a fake whose replies this file releases by hand.

import { createElement } from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NotificationsSection } from '@/components/gateway/notifications-section';

const mockRequest = jest.fn();
const mockPermissionRead = jest.fn();
// The roster effect reads `listBots` off the context, so a fresh jest.fn on
// every render would re-run that effect forever.
const mockListBots = jest.fn().mockResolvedValue([{ id: 'bot-a', displayName: 'Alpha' }]);
jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    activeGateway: { kind: 'custom' },
    status: 'connected',
    gatewayRequest: mockRequest,
    listBots: mockListBots,
  }),
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: () => mockPermissionRead(),
  requestPermissionsAsync: jest.fn(),
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn().mockResolvedValue({ deviceId: 'test-device' }),
  syncPushRegistration: jest.fn(),
}));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const GRANTED = { granted: true, status: 'granted', canAskAgain: false };
const DENIED = { granted: false, status: 'denied', canAskAgain: false };
/** A phone nobody has asked: Android 13+ and every first launch on iOS. */
const UNDETERMINED = { granted: false, status: 'undetermined', canAskAgain: true };

/** The Gate's row on arrival, with quiet hours already set — the state the
 *  seeded-fields defect needs, and the ordinary one. */
const STORED: Record<string, unknown> = {
  enabled: true,
  richBody: true,
  widgetUpdates: false,
  botIds: ['bot-a'],
  quietHours: { startMinutes: 1320, endMinutes: 420 },
  quietHoursAllowApprovals: false,
};

let stored: Record<string, unknown>;
let replies: Deferred<Record<string, unknown>>[];
let sent: { method: string; params: Record<string, unknown> }[];
let renderer: ReactTestRenderer;
let appStateListeners: ((state: string) => void)[];

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
  }
}

/** The props this file drives, typed so a call site is a call site. */
type Control = {
  props: {
    value?: unknown;
    disabled?: unknown;
    label?: unknown;
    cause?: unknown;
    next?: unknown;
    onChangeText?: (text: string) => void;
    onValueChange?: (value: boolean) => void;
    onPress?: () => void;
    onRetry?: () => void;
  };
};

function control(accessibilityLabel: string): Control {
  const found = renderer.root.findAll((node) => node.props?.accessibilityLabel === accessibilityLabel);
  expect(found.length).toBeGreaterThan(0);
  return found[0] as unknown as Control;
}

function field(accessibilityLabel: string): Control {
  return control(accessibilityLabel);
}

function button(label: string): Control {
  const found = renderer.root.findAll(
    (node) => (node.type as unknown) === 'Button' && node.props?.label === label,
  );
  expect(found.length).toBeGreaterThan(0);
  return found[0] as unknown as Control;
}

function errorCard(): Control | undefined {
  return renderer.root.findAll((node) => (node.type as unknown) === 'ErrorCard')[0] as unknown as
    | Control
    | undefined;
}

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

function screen(): string {
  return stringsIn(renderer.toJSON()).join(' ');
}

function writes(): { method: string; params: Record<string, unknown> }[] {
  return sent.filter((call) => call.method === 'notifications.preferences.set');
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(NotificationsSection));
  });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  stored = { ...STORED };
  replies = [];
  sent = [];
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    type: string,
    handler: (state: string) => void,
  ) => {
    if (type === 'change') appStateListeners.push(handler);
    return { remove: () => undefined };
  }) as unknown as typeof AppState.addEventListener);
  mockPermissionRead.mockReset().mockResolvedValue(GRANTED);
  mockRequest.mockReset().mockImplementation((method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    if (method === 'notifications.preferences.set') {
      const reply = replies.shift();
      if (!reply) return Promise.reject(new Error('a write was issued with no reply waiting for it'));
      return reply.promise.then((row) => {
        stored = { ...stored, ...row };
        return row;
      });
    }
    return Promise.resolve(stored);
  });
});

afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a quiet-hours edit survives another switch on the same card, and Save sends what is typed', async () => {
  await mount();
  expect(field('Quiet hours start, HH:MM').props.value).toBe('22:00');
  expect(field('Quiet hours end, HH:MM').props.value).toBe('07:00');

  act(() => {
    field('Quiet hours start, HH:MM').props.onChangeText?.('23:30');
  });
  expect(field('Quiet hours start, HH:MM').props.value).toBe('23:30');

  // Now flip something else on this screen. The write answers with a row of its
  // own — the hook's `normalize` builds a fresh object for every answer — and
  // the typed window used to be overwritten by that answer a beat later.
  const widget = deferred<Record<string, unknown>>();
  replies.push(widget);
  act(() => {
    control('Send data-only widget updates').props.onValueChange?.(true);
  });
  // The switch itself moves on the tap, not after the round trip.
  expect(control('Send data-only widget updates').props.value).toBe(true);
  await flush();

  widget.resolve({ ...stored, widgetUpdates: true });
  await flush();
  expect(field('Quiet hours start, HH:MM').props.value).toBe('23:30');
  expect(field('Quiet hours end, HH:MM').props.value).toBe('07:00');

  const save = deferred<Record<string, unknown>>();
  replies.push(save);
  act(() => {
    button('Save quiet hours').props.onPress?.();
  });
  await flush();
  expect(writes().map((call) => call.params)).toEqual([
    { widgetUpdates: true, deviceId: 'test-device' },
    { quietHours: { startMinutes: 1410, endMinutes: 420 }, deviceId: 'test-device' },
  ]);

  save.resolve({ ...stored, quietHours: { startMinutes: 1410, endMinutes: 420 } });
  await flush();
  expect(field('Quiet hours start, HH:MM').props.value).toBe('23:30');
  expect(errorCard()).toBeUndefined();
});

test('a save the Gate took hands the fields back to the Gate', async () => {
  await mount();
  act(() => {
    field('Quiet hours start, HH:MM').props.onChangeText?.('23:30');
  });

  // Another device moved the stored window while this draft is unsaved. The
  // fields are the operator's until a save takes them, so that answer must not
  // land on top of the typing.
  const elsewhere = deferred<Record<string, unknown>>();
  replies.push(elsewhere);
  act(() => {
    control('Send data-only widget updates').props.onValueChange?.(true);
  });
  await flush();
  elsewhere.resolve({ ...stored, widgetUpdates: true, quietHours: { startMinutes: 1260, endMinutes: 420 } });
  await flush();
  expect(field('Quiet hours start, HH:MM').props.value).toBe('23:30');

  const save = deferred<Record<string, unknown>>();
  replies.push(save);
  act(() => {
    button('Save quiet hours').props.onPress?.();
  });
  await flush();
  save.resolve({ ...stored, quietHours: { startMinutes: 1410, endMinutes: 420 } });
  await flush();
  expect(field('Quiet hours start, HH:MM').props.value).toBe('23:30');

  // The stored window is the Gate's again, so a later change to it — another
  // device, or the Gate's own default — re-seeds the field rather than leaving
  // a stale draft pinned over the truth.
  const later = deferred<Record<string, unknown>>();
  replies.push(later);
  act(() => {
    control('Send data-only widget updates').props.onValueChange?.(false);
  });
  await flush();
  later.resolve({ ...stored, widgetUpdates: false, quietHours: { startMinutes: 1260, endMinutes: 420 } });
  await flush();
  expect(field('Quiet hours start, HH:MM').props.value).toBe('21:00');
});

test('a refused save keeps the window the operator typed', async () => {
  await mount();
  act(() => {
    field('Quiet hours start, HH:MM').props.onChangeText?.('23:30');
  });

  const refused = deferred<Record<string, unknown>>();
  replies.push(refused);
  act(() => {
    button('Save quiet hours').props.onPress?.();
  });
  await flush();
  refused.reject(new Error('the Gate refused this write'));
  await flush();

  // The row rolled back to the window the Gate really holds, so the fields must
  // not follow it: the edit is still unsaved and still the operator's.
  expect(field('Quiet hours start, HH:MM').props.value).toBe('23:30');
  expect(errorCard()?.props.cause).toMatch(/refused this write/);

  // Retry hands the card the Gate's own row, and the unsaved edit is still the
  // operator's to try again rather than something the read quietly overwrites.
  act(() => {
    errorCard()?.props.onRetry?.();
  });
  await flush();
  expect(field('Quiet hours start, HH:MM').props.value).toBe('23:30');
  expect(field('Quiet hours end, HH:MM').props.value).toBe('07:00');
});

test('a fresh install is told nothing false about its permission', async () => {
  mockPermissionRead.mockResolvedValue(UNDETERMINED);
  await mount();

  // The card's own copy says permission is asked here, never at launch. Printing
  // "the OS currently reports notifications as denied" two lines under it, on a
  // phone nobody has ever asked, is the screen contradicting itself.
  expect(screen()).toContain('Permission is asked here');
  expect(screen()).not.toContain('reports notifications as denied');
});

test('a revoke in OS Settings is what the card then says', async () => {
  await mount();
  expect(screen()).not.toContain('reports notifications as denied');

  // The operator leaves for Android Settings and switches notifications off for
  // Versutus, then comes back. This screen is a Stack child, so the trip does
  // not remount it: only a read on the foreground edge can catch it.
  mockPermissionRead.mockResolvedValue(DENIED);
  await act(async () => {
    for (const listener of appStateListeners) listener('active');
  });
  await flush();

  expect(screen()).toContain('reports notifications as denied');
});

test('a refused write locks the switches the error card says are locked', async () => {
  await mount();
  expect(control('Include message text in notifications').props.disabled).toBe(false);

  const refused = deferred<Record<string, unknown>>();
  replies.push(refused);
  act(() => {
    control('Include message text in notifications').props.onValueChange?.(false);
  });
  await flush();
  refused.reject(new Error('the Gate refused this write'));
  await flush();

  // The card promises the switches stay locked until the Gate's own settings are
  // read. It said that while they were live, and the operator's next tap
  // re-issued the same write the Gate had just refused.
  expect(errorCard()?.props.next).toMatch(/stay locked/);
  expect(control('Include message text in notifications').props.disabled).toBe(true);
  expect(control('Send data-only widget updates').props.disabled).toBe(true);
  expect(control('Push notifications from this Gate').props.disabled).toBe(true);

  // Retry re-reads, and a read that lands hands the switches back.
  act(() => {
    errorCard()?.props.onRetry?.();
  });
  await flush();
  expect(control('Include message text in notifications').props.disabled).toBe(false);
  expect(errorCard()).toBeUndefined();
});

// ─── Gate preference writes: taken at once, sent one at a time ────────────
// A switch is a promise the operator can see: it moves the moment it is
// flipped, and the Gate is told afterwards. Three things were false of that.
// The write waited for a reply that can take the whole 30 s request timeout to
// arrive, so a switch sat still after a tap. Every write painted the whole card
// from the row ITS OWN reply returned, so a slow reply could repaint a row an
// earlier, faster reply had already moved past — the screen showing the Gate's
// older truth. And `saving` was cleared by whichever write finished first, which
// handed the switches back with another still in the air.
//
// The fake Gate answers each write from a promise this file holds, so a reply
// can be made to land when the test says so.

import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useNotificationPreferences } from '@/hooks/use-notification-preferences';

const mockRequest = jest.fn();
const mockPermissionRead = jest.fn();
// The gateway the hook sees. A switch to B is a new `activeGateway.id`, which
// is what re-runs `load` and re-keys the write queue.
const gatewayState: { id: string; kind: string; status: string } = {
  id: 'gw-a',
  kind: 'custom',
  status: 'connected',
};
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    activeGateway: { id: gatewayState.id, kind: gatewayState.kind },
    status: gatewayState.status,
    gatewayRequest: mockRequest,
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

/** A reply this file releases by hand, so a write can be held in the air. */
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

/** The row the Gate holds before anything is written. */
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
let getReplies: Deferred<Record<string, unknown>>[];
let sent: { method: string; params: Record<string, unknown> }[];

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

let renderer: ReactTestRenderer;

/**
 * Let every timer and promise chain the hook owns settle. Several rounds,
 * because one round drains one link of an `await` chain and the hook's own
 * paths are two or three deep.
 */
async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
  }
}

beforeEach(async () => {
  jest.useFakeTimers();
  stored = { ...STORED };
  replies = [];
  getReplies = [];
  sent = [];
  gatewayState.id = 'gw-a';
  gatewayState.status = 'connected';
  mockPermissionRead.mockReset().mockResolvedValue(GRANTED);
  mockRequest.mockReset().mockImplementation((method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    if (method === 'notifications.preferences.set') {
      const reply = replies.shift();
      if (!reply) return Promise.reject(new Error('a write was issued with no reply waiting for it'));
      // The Gate merges the patch onto its one row per device and answers with
      // the whole row, which is what the app paints.
      return reply.promise.then((row) => {
        stored = { ...stored, ...row };
        return row;
      });
    }
    // A read can be held too, so a load against gateway A can outlive the
    // switch to B.
    const held = getReplies.shift();
    return held ? held.promise : Promise.resolve(stored);
  });
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  await flush();
});

/**
 * Re-render with a new gateway, flipping the link through `connecting` the way
 * a real switch does, and settle the reads the switch triggers.
 */
async function switchGateway(id: string, status: string): Promise<void> {
  gatewayState.id = id;
  gatewayState.status = status;
  await act(async () => {
    renderer.update(createElement(Harness));
  });
  await flush();
}

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  jest.useRealTimers();
});

function writes(): { method: string; params: Record<string, unknown> }[] {
  return sent.filter((call) => call.method === 'notifications.preferences.set');
}

test('a switch moves when it is flipped, not when the Gate answers', async () => {
  const reply = deferred<Record<string, unknown>>();
  replies.push(reply);

  act(() => {
    void preferences.setPatch({ widgetUpdates: true });
  });
  // Nothing has come back from the Gate yet, and the row on screen is already
  // the one the operator asked for.
  expect(preferences.prefs.widgetUpdates).toBe(true);
  expect(preferences.saving).toBe(true);

  await flush();
  // One write out, carrying the patch the switch names and the phone's id.
  expect(writes()).toEqual([
    { method: 'notifications.preferences.set', params: { widgetUpdates: true, deviceId: 'test-device' } },
  ]);
  expect(preferences.saving).toBe(true);

  reply.resolve({ ...stored, widgetUpdates: true });
  await flush();
  expect(preferences.prefs.widgetUpdates).toBe(true);
  expect(preferences.saving).toBe(false);
  expect(preferences.error).toBeNull();
  expect(preferences.synced).toBe(true);
});

test('two flips in a second are two ordered writes, and the card never repaints backwards', async () => {
  const first = deferred<Record<string, unknown>>();
  const second = deferred<Record<string, unknown>>();
  replies.push(first, second);

  act(() => {
    void preferences.setPatch({ widgetUpdates: true });
    void preferences.setPatch({ richBody: false });
  });
  await flush();

  // Both taps are on screen, and only one write is in the air: the Gate keeps
  // one row per device, so a second write computed from a row the first has not
  // answered yet would drop the first field.
  expect(writes()).toHaveLength(1);
  expect(preferences.prefs).toMatchObject({ widgetUpdates: true, richBody: false });

  // The Gate answers the first write with the row as it stood BEFORE the second
  // tap. An older reply must not paint over the newer tap.
  first.resolve({ ...stored, widgetUpdates: true, richBody: true });
  await flush();
  expect(writes()).toHaveLength(2);
  expect(preferences.prefs.richBody).toBe(false);
  expect(preferences.saving).toBe(true);

  second.resolve({ ...stored, widgetUpdates: true, richBody: false });
  await flush();
  // The card ends on the Gate's final row, and `saving` waits for the last one.
  expect(preferences.prefs).toMatchObject({ widgetUpdates: true, richBody: false });
  expect(preferences.saving).toBe(false);
  expect(preferences.error).toBeNull();
  expect(writes().map((call) => call.params)).toEqual([
    { widgetUpdates: true, deviceId: 'test-device' },
    { richBody: false, deviceId: 'test-device' },
  ]);
});

test('a refused write rolls back to the row the Gate confirmed and locks the card', async () => {
  expect(preferences.synced).toBe(true);
  const refused = deferred<Record<string, unknown>>();
  replies.push(refused);

  act(() => {
    void preferences.setPatch({ richBody: false });
  });
  expect(preferences.prefs.richBody).toBe(false);
  await flush();

  refused.reject(new Error('the Gate refused this write'));
  await flush();

  // Back to the row the Gate itself last confirmed — not to whatever a reply in
  // flight claimed — and `synced` cleared, because the error card above the
  // switches tells the operator they stay locked until the Gate's own settings
  // are read.
  expect(preferences.prefs.richBody).toBe(true);
  expect(preferences.synced).toBe(false);
  expect(preferences.error).toMatch(/refused this write/);
  expect(preferences.saving).toBe(false);

  // Retry re-reads, and a read that lands hands the switches back.
  stored = { ...stored, richBody: false };
  await act(async () => {
    await preferences.reload();
  });
  expect(preferences.synced).toBe(true);
  expect(preferences.error).toBeNull();
  expect(preferences.prefs.richBody).toBe(false);
});

test('a write that lands re-reads the phone, so a revoke cannot outlive the screen', async () => {
  // The mount read is the only read the hook used to make, ever: a permission
  // revoked in Android Settings after that was answered nothing here.
  expect(mockPermissionRead).toHaveBeenCalledTimes(1);

  const reply = deferred<Record<string, unknown>>();
  replies.push(reply);
  act(() => {
    void preferences.setPatch({ widgetUpdates: true });
  });
  reply.resolve({ ...stored, widgetUpdates: true });
  await flush();

  expect(mockPermissionRead).toHaveBeenCalledTimes(2);
});

test('a slow read of the old gateway cannot paint over the new gateway', async () => {
  // Gateway A is connected over a lossy link; its preferences reload is held.
  const heldFromA = deferred<Record<string, unknown>>();
  getReplies.push(heldFromA);
  const rowA = { ...STORED, richBody: true };
  const rowB = { ...STORED, richBody: false };
  act(() => {
    void preferences.reload();
  });
  await flush();

  // Switch to B: the link flips through connecting, the hook re-runs `load`,
  // and B answers first with its own row.
  await switchGateway('gw-b', 'connecting');
  stored = rowB;
  await switchGateway('gw-b', 'connected');
  expect(preferences.prefs.richBody).toBe(false);
  expect(preferences.synced).toBe(true);

  // A's late reply now lands. It must paint nothing: the screen belongs to B.
  await act(async () => {
    heldFromA.resolve(rowA);
  });
  await flush();

  expect(preferences.prefs.richBody).toBe(false);
  expect(preferences.synced).toBe(true);
});

test('a write queued under one gateway is dropped, not flushed to the next', async () => {
  // The patch is computed against A's row and queued while A's own write is in
  // the air, so it has not been sent when the operator switches.
  const firstReply = deferred<Record<string, unknown>>();
  replies.push(firstReply);
  act(() => {
    void preferences.setPatch({ widgetUpdates: true });
  });
  act(() => {
    void preferences.setPatch({ richBody: false });
  });
  await flush();
  expect(writes()).toHaveLength(1);

  // Switch before A's first write lands. The queued `richBody` patch was
  // computed from A's row, so it must be dropped rather than sent through B.
  await switchGateway('gw-b', 'connecting');
  await switchGateway('gw-b', 'connected');

  firstReply.resolve({ ...stored, widgetUpdates: true });
  await flush();

  expect(preferences.saving).toBe(false);
  // Nothing carrying B's row was ever sent from the abandoned queue.
  for (const write of writes()) {
    expect(write.params).not.toHaveProperty('richBody', false);
  }
});

// ─── Whose notification row is on screen? ─────────────────────────────────
// The hook's reads, writes and rollback target all belong to ONE gateway, but
// every callback it hands out is stable across a switch. So a stale callback,
// or a reply the old gateway still owed, used to write and paint the new
// gateway's row before the new gateway had been read at all. These tests hold
// each RPC open by hand, switch gateways without changing the connection
// status (so `connected` and the provider's stable `gatewayRequest` never
// change), and make the old gateway's answers land at the worst moment.

import { createElement, useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useNotificationPreferences } from '@/hooks/use-notification-preferences';
import { pushDeviceParams, syncPushRegistration } from '@/lib/notifications/push-registration';

const mockRequest = jest.fn();
// The gateway the hook sees. A switch frequently leaves `status` at
// `connected` and `gatewayRequest` is the same stable callback either way:
// only the id changes, which is exactly the case the old load missed.
const mockGatewayState: { id: string; kind: string; status: string } = {
  id: 'gw-a',
  kind: 'custom',
  status: 'connected',
};
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    activeGateway: { id: mockGatewayState.id, kind: mockGatewayState.kind },
    status: mockGatewayState.status,
    gatewayRequest: mockRequest,
  }),
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted', canAskAgain: false }),
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

/** A reply this file releases by hand, so a read or write stays in the air. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** NotificationPreferences as the hook paints them before any row has landed. */
const PLACEHOLDER = {
  enabled: false,
  richBody: false,
  widgetUpdates: false,
  botIds: [],
  quietHours: null,
  quietHoursAllowApprovals: false,
};

/** Gateway A's row: every switch in a different place from the placeholder. */
const ROW_A: Record<string, unknown> = {
  enabled: true,
  richBody: true,
  widgetUpdates: true,
  botIds: ['bot-a'],
  quietHours: { startMinutes: 1320, endMinutes: 420 },
  quietHoursAllowApprovals: true,
};

/** Gateway B's row: distinguishable from A's in every field a switch reads. */
const ROW_B: Record<string, unknown> = {
  enabled: true,
  richBody: false,
  widgetUpdates: false,
  botIds: ['bot-b'],
  quietHours: null,
  quietHoursAllowApprovals: false,
};

type Sent = { method: string; params: Record<string, unknown>; gateway: string };

let rows: Record<string, Record<string, unknown>>;
let readReplies: Deferred<Record<string, unknown>>[];
let writeReplies: Deferred<Record<string, unknown>>[];
let sent: Sent[];

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
  (Notifications.getPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true, status: 'granted', canAskAgain: false });
  (Notifications.requestPermissionsAsync as jest.Mock).mockReset();
  (syncPushRegistration as jest.Mock).mockClear();
  rows = { 'gw-a': { ...ROW_A }, 'gw-b': { ...ROW_B } };
  readReplies = [];
  writeReplies = [];
  sent = [];
  mockGatewayState.id = 'gw-a';
  mockGatewayState.status = 'connected';
  (pushDeviceParams as unknown as jest.Mock)
    .mockReset()
    .mockResolvedValue({ deviceId: 'test-device' });
  mockRequest.mockReset().mockImplementation((method: string, params: Record<string, unknown>) => {
    // The gateway this call leaves through, captured now: a reply that lands
    // later must still be attributable to the row it was actually asked of.
    const gateway = mockGatewayState.id;
    sent.push({ method, params, gateway });
    if (method === 'notifications.preferences.get') {
      const held = readReplies.shift();
      return held ? held.promise : Promise.resolve(rows[gateway]);
    }
    if (method === 'notifications.preferences.set') {
      const held = writeReplies.shift();
      if (!held) return Promise.reject(new Error('a write was issued with no reply waiting for it'));
      // The Gate merges the patch onto its one row per device and answers with
      // the whole row, which is what the app paints.
      return held.promise.then((row) => {
        rows[gateway] = { ...rows[gateway], ...row };
        return row;
      });
    }
    return Promise.resolve({});
  });
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
});

/**
 * Re-render with a new gateway. `status` defaults to `connected`, so the switch
 * changes nothing the old load dependencies watched — only `activeGateway.id`.
 */
async function switchTo(id: string, status = 'connected'): Promise<void> {
  mockGatewayState.id = id;
  mockGatewayState.status = status;
  await act(async () => {
    renderer.update(createElement(Harness));
  });
  await flush();
}

function reads(): Sent[] {
  return sent.filter((call) => call.method === 'notifications.preferences.get');
}

function writes(): Sent[] {
  return sent.filter((call) => call.method === 'notifications.preferences.set');
}

function writesFor(gateway: string): Sent[] {
  return writes().filter((call) => call.gateway === gateway);
}

test('a switch reads B before anything of A is editable, and B alone unlocks B', async () => {
  // A has landed: its row is on screen and its switches are live.
  expect(preferences.synced).toBe(true);
  expect(preferences.prefs).toMatchObject(ROW_A);

  // B's read is held in the air.
  const heldB = deferred<Record<string, unknown>>();
  readReplies.push(heldB);
  await switchTo('gw-b');

  // The switch asked B. (Under the old hook it never did: neither `connected`
  // nor the stable `gatewayRequest` changed, so `load` was never re-made.)
  expect(reads()).toHaveLength(2);
  expect(reads()[1].gateway).toBe('gw-b');

  // While B is pending, A's row is not the screen and nothing is writable.
  expect(preferences.synced).toBe(false);
  expect(preferences.loading).toBe(true);
  expect(preferences.prefs).toEqual(PLACEHOLDER);
  expect(preferences.prefs.widgetUpdates).toBe(false);

  // A switch drawn from A calls the hook's stable write entry point. It must
  // be refused at the hook, not merely disabled in the component.
  let accepted: boolean | undefined;
  act(() => {
    void preferences.setPatch({ widgetUpdates: true }).then((value) => {
      accepted = value;
    });
  });
  await flush();
  expect(accepted).toBe(false);
  expect(writes()).toHaveLength(0);
  expect(preferences.prefs.widgetUpdates).toBe(false);

  // B's own read is what unlocks B, and it paints B's row.
  heldB.resolve(ROW_B);
  await flush();
  expect(preferences.synced).toBe(true);
  expect(preferences.prefs).toMatchObject(ROW_B);
  expect(preferences.prefs.widgetUpdates).toBe(false);

  // A write now belongs to B and carries only the patch being asked for.
  const taken = deferred<Record<string, unknown>>();
  writeReplies.push(taken);
  act(() => {
    void preferences.setPatch({ richBody: true });
  });
  await flush();
  expect(writesFor('gw-b')).toEqual([
    {
      method: 'notifications.preferences.set',
      params: { richBody: true, deviceId: 'test-device' },
      gateway: 'gw-b',
    },
  ]);
  taken.resolve({ ...ROW_B, richBody: true });
  await flush();
  expect(preferences.prefs.richBody).toBe(true);
  expect(preferences.synced).toBe(true);
});

test('a write waiting on the phone identity is dropped, not sent through B', async () => {
  // Take a write on A and hold it in the device-id await that precedes the
  // RPC, so the operator can switch while it is still unsent.
  const identity = deferred<{ deviceId: string }>();
  (pushDeviceParams as unknown as jest.Mock).mockReturnValueOnce(identity.promise);

  act(() => {
    void preferences.setPatch({ richBody: false });
  });
  await flush();
  // Nothing has left yet: the hook is still naming the phone.
  expect(writes()).toHaveLength(0);

  const heldB = deferred<Record<string, unknown>>();
  readReplies.push(heldB);
  await switchTo('gw-b');

  // The identity answer arrives after the switch. A's patch was computed from
  // A's row and must be dropped rather than sent through B's client.
  identity.resolve({ deviceId: 'test-device' });
  await flush();
  expect(writes()).toHaveLength(0);
  expect(writesFor('gw-b')).toHaveLength(0);
  expect(preferences.synced).toBe(false);

  // B still has to be read before anything of B's can be written.
  heldB.resolve(ROW_B);
  await flush();
  expect(preferences.synced).toBe(true);
  expect(preferences.prefs).toMatchObject(ROW_B);
});

test('a late success from A cannot repaint or unlock B', async () => {
  // A is on screen; a re-read of A is held in the air when the operator leaves.
  const lateA = deferred<Record<string, unknown>>();
  readReplies.push(lateA);
  act(() => {
    void preferences.reload();
  });
  await flush();

  const heldB = deferred<Record<string, unknown>>();
  readReplies.push(heldB);
  await switchTo('gw-b');
  expect(preferences.synced).toBe(false);
  expect(preferences.prefs).toEqual(PLACEHOLDER);

  // A's read lands, with a row that would look like a perfectly good answer.
  lateA.resolve({ ...ROW_A, richBody: false, widgetUpdates: true });
  await flush();

  // B is still unread, so the screen is still the placeholder and locked.
  expect(preferences.synced).toBe(false);
  expect(preferences.prefs).toEqual(PLACEHOLDER);
  expect(preferences.loading).toBe(true);

  // A stale write callback still cannot reach B.
  let accepted: boolean | undefined;
  act(() => {
    void preferences.setPatch({ widgetUpdates: true }).then((value) => {
      accepted = value;
    });
  });
  await flush();
  expect(accepted).toBe(false);
  expect(writesFor('gw-b')).toHaveLength(0);

  // B's refusal is the only verdict about B.
  heldB.reject(new Error('the Gate refused this read'));
  await flush();
  expect(preferences.synced).toBe(false);
  expect(preferences.prefs).toEqual(PLACEHOLDER);
  expect(preferences.error).toMatch(/refused this read/);
});

test('a late refusal from A cannot repaint or unlock B', async () => {
  const lateA = deferred<Record<string, unknown>>();
  readReplies.push(lateA);
  act(() => {
    void preferences.reload();
  });
  await flush();

  const heldB = deferred<Record<string, unknown>>();
  readReplies.push(heldB);
  await switchTo('gw-b');

  // A's refusal lands while B is still in flight. It is not an error about B
  // and it does not unlock anything.
  lateA.reject(new Error('gateway A refused this read'));
  await flush();
  expect(preferences.error).toBeNull();
  expect(preferences.synced).toBe(false);
  expect(preferences.prefs).toEqual(PLACEHOLDER);
  expect(preferences.loading).toBe(true);

  // B answers next, and only B's answer is painted.
  heldB.resolve(ROW_B);
  await flush();
  expect(preferences.synced).toBe(true);
  expect(preferences.prefs).toMatchObject(ROW_B);
  expect(preferences.error).toBeNull();
});

test('B refused: A stays off screen, B recovery unlocks B, and rollback is B', async () => {
  const refusedB = deferred<Record<string, unknown>>();
  readReplies.push(refusedB);
  await switchTo('gw-b');
  refusedB.reject(new Error('the Gate refused this read'));
  await flush();

  // B's refusal is what the card says, and A's row is nowhere on it.
  expect(preferences.synced).toBe(false);
  expect(preferences.error).toMatch(/refused this read/);
  expect(preferences.prefs).toEqual(PLACEHOLDER);
  expect(preferences.prefs.widgetUpdates).toBe(false);

  // The hook refuses stale writes on its own, before anything reaches B.
  let accepted: boolean | undefined;
  act(() => {
    void preferences.setPatch({ widgetUpdates: true }).then((value) => {
      accepted = value;
    });
  });
  await flush();
  expect(accepted).toBe(false);
  expect(writesFor('gw-b')).toHaveLength(0);

  // B recovers: a fresh read of B lands and unlocks B alone.
  const recovery = deferred<Record<string, unknown>>();
  readReplies.push(recovery);
  act(() => {
    void preferences.reload();
  });
  await flush();
  expect(reads()[reads().length - 1].gateway).toBe('gw-b');
  recovery.resolve(ROW_B);
  await flush();
  expect(preferences.synced).toBe(true);
  expect(preferences.prefs).toEqual(ROW_B);

  // A correct B write carries only the patch.
  const taken = deferred<Record<string, unknown>>();
  writeReplies.push(taken);
  act(() => {
    void preferences.setPatch({ richBody: true });
  });
  await flush();
  expect(writesFor('gw-b')).toEqual([
    {
      method: 'notifications.preferences.set',
      params: { richBody: true, deviceId: 'test-device' },
      gateway: 'gw-b',
    },
  ]);
  taken.resolve({ ...ROW_B, richBody: true });
  await flush();
  expect(preferences.prefs.richBody).toBe(true);

  // A refused B write rolls back to the row B itself confirmed, then locks.
  const refusedWrite = deferred<Record<string, unknown>>();
  writeReplies.push(refusedWrite);
  act(() => {
    void preferences.setPatch({ widgetUpdates: true });
  });
  await flush();
  refusedWrite.reject(new Error('the Gate refused this write'));
  await flush();
  expect(preferences.prefs.richBody).toBe(true);
  expect(preferences.prefs.widgetUpdates).toBe(false);
  expect(preferences.synced).toBe(false);
  expect(preferences.error).toMatch(/refused this write/);

  let acceptedAgain: boolean | undefined;
  act(() => {
    void preferences.setPatch({ richBody: false }).then((value) => {
      acceptedAgain = value;
    });
  });
  await flush();
  expect(acceptedAgain).toBe(false);
  // The taken write and the refused one; the locked tap issued no third.
  expect(writesFor('gw-b')).toHaveLength(2);
});

test('a same-gateway reconnect that refuses the reread locks edits until a read lands', async () => {
  expect(preferences.synced).toBe(true);

  // The link drops and comes back on the SAME gateway. The reread is held.
  const reread = deferred<Record<string, unknown>>();
  readReplies.push(reread);
  await switchTo('gw-a', 'connecting');
  await switchTo('gw-a', 'connected');
  // The reconnect re-asked the Gate — the held reread would otherwise be the
  // mount read and this test would pass on a hook that never re-read.
  expect(reads()).toHaveLength(2);
  expect(reads()[reads().length - 1].gateway).toBe('gw-a');

  // A reconnect is not a read: while it is in flight the card is locked and
  // holds the placeholder, not the row that was on screen a moment ago.
  expect(preferences.synced).toBe(false);
  expect(preferences.prefs).toEqual(PLACEHOLDER);

  let accepted: boolean | undefined;
  act(() => {
    void preferences.setPatch({ richBody: false }).then((value) => {
      accepted = value;
    });
  });
  await flush();
  expect(accepted).toBe(false);
  expect(writes()).toHaveLength(0);

  // The reread refuses, so the lock stands.
  reread.reject(new Error('the Gate refused this read'));
  await flush();
  expect(preferences.synced).toBe(false);
  expect(preferences.prefs).toEqual(PLACEHOLDER);
  expect(preferences.error).toMatch(/refused this read/);

  // And only a read that lands hands the switches back.
  await act(async () => {
    await preferences.reload();
  });
  await flush();
  expect(preferences.synced).toBe(true);
  expect(preferences.prefs).toEqual(ROW_A);
  expect(preferences.error).toBeNull();
});


test.each(['read', 'prompt'] as const)('an enable waiting for a permission %s cannot write a newly read gateway', async (stage) => {
  const permission = deferred<{ granted: boolean; status: string; canAskAgain: boolean }>();
  if (stage === 'read') {
    (Notifications.getPermissionsAsync as jest.Mock).mockReturnValueOnce(permission.promise);
  } else {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false, status: 'undetermined', canAskAgain: true });
    (Notifications.requestPermissionsAsync as jest.Mock).mockReturnValueOnce(permission.promise);
  }
  let accepted: boolean | undefined;
  act(() => { void preferences.setEnabled(true).then((value) => { accepted = value; }); });
  await flush();
  await switchTo('gw-b');
  expect(preferences.synced).toBe(true);
  expect(preferences.prefs).toMatchObject(ROW_B);
  permission.resolve({ granted: true, status: 'granted', canAskAgain: false });
  await flush();
  expect(writes()).toHaveLength(0);
  expect(syncPushRegistration).not.toHaveBeenCalled();
  expect(accepted).toBe(false);
  expect(preferences.prefs).toMatchObject(ROW_B);
});

test.each([true, false])('setEnabled(%s) reports a refused write without registering a push', async (enabled) => {
  const refused = deferred<Record<string, unknown>>();
  writeReplies.push(refused);
  let accepted: boolean | undefined;
  act(() => { void preferences.setEnabled(enabled).then((value) => { accepted = value; }); });
  await flush();
  expect(writes()).toHaveLength(1);
  refused.reject(new Error('write refused'));
  await flush();
  expect(accepted).toBe(false);
  expect(syncPushRegistration).not.toHaveBeenCalled();
  expect(preferences.synced).toBe(false);
});

// The routine notice's permission gate, and what two overlapping re-arms do to
// one job's queued notice.
//
// Three defects are pinned here, all of them visible only in a race or a
// collision:
// - the gate asked the phone for permission once per routine per re-arm (N
//   concurrent requests per fan-out), from the background, where Android 13+
//   cannot show the dialog at all. It is now local.ts's shared read-first gate,
//   so one re-arm costs at most one read and one request, and a backgrounded
//   caller never asks.
// - two overlapping re-arms each scheduled a new notice for the same job, both
//   retired the OLD id and both wrote a new one, orphaning one notice in the OS
//   queue forever. The per-job chain plus the record-before-retire order leave
//   exactly one queued notice.
// - nothing ever enumerated the queue, so the orphans earlier collisions left
//   were never retired. The reconcile that closes a re-arm does, scoped to the
//   jobs that read names — a Bot Chat's read carries only its own Bot's jobs.

type RoutineSync = typeof import('@/lib/notifications/routine-sync');
type NotificationsMock = {
  scheduleNotificationAsync: jest.Mock;
  cancelScheduledNotificationAsync: jest.Mock;
  getAllScheduledNotificationsAsync: jest.Mock;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  /** The phone's queue: identifier -> the job id that notice belongs to. */
  __queue: Map<string, string>;
  /** Every native call this module made, in the order the phone saw it. */
  __calls: string[];
};

// Both mocks answer a macrotask later. That is not decoration: a real native
// call and a real store write both come back after the caller has suspended, and
// two overlapping re-arms interleave across exactly those suspensions. A mock
// that answered synchronously would serialise the very race under test.
//
// `scheduleNotificationAsync` keeps the phone's queue, so "how many notices is
// the phone holding" is an assertion rather than an inference.
jest.mock('expo-notifications', () => {
  const queue = new Map<string, string>();
  const calls: string[] = [];
  let minted = 0;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' },
    scheduleNotificationAsync: jest.fn(async (request: { content?: { data?: { jobId?: string } } }) => {
      await tick();
      calls.push('schedule');
      const identifier = `notif-${(minted += 1)}`;
      queue.set(identifier, request?.content?.data?.jobId ?? '');
      return identifier;
    }),
    cancelScheduledNotificationAsync: jest.fn(async (identifier: string) => {
      await tick();
      calls.push(`cancel:${identifier}`);
      queue.delete(identifier);
    }),
    getAllScheduledNotificationsAsync: jest.fn(async () => {
      await tick();
      calls.push('enumerate');
      return [...queue].map(([identifier, jobId]) => ({
        identifier,
        content: {
          title: 'due',
          body: '',
          data: { kind: 'routine-due', jobId },
          categoryIdentifier: null,
          sound: 'default',
        },
        trigger: null,
      }));
    }),
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    __queue: queue,
    __calls: calls,
  };
});

jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    getItem: jest.fn(async (key: string) => {
      await tick();
      return store[key] ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      await tick();
      store[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      await tick();
      delete store[key];
    }),
  };
});

type ReactNative = typeof import('react-native');

/**
 * A fresh copy of the modules, because what is under test is module-level state
 * on both sides: the permission gate's cached grant and remembered refusal, and
 * the per-job sync chain. Both must be re-established per case or a case
 * inherits what the previous one left behind — and the AppState the fresh copies
 * read is a fresh object too, so it is set through here, not through an import.
 */
function freshRoutineSync(): {
  sync: RoutineSync;
  notifications: NotificationsMock;
  storedIdFor: (jobId: string) => Promise<string | null>;
  setState: (value: string) => void;
} {
  jest.resetModules();
  const notifications = jest.requireMock<NotificationsMock>('expo-notifications');
  const reactNative = jest.requireActual<ReactNative>('react-native');
  const sync = jest.requireActual<RoutineSync>('@/lib/notifications/routine-sync');
  const storage = jest.requireActual<typeof import('@/lib/storage/key-value')>(
    '@/lib/storage/key-value',
  ).keyValueStorage;
  // The dialog answers GRANTED by default, so a gate that asks where it should
  // read cannot hide behind a mute mock: it asks, it is granted, and the notice
  // it should never have armed is armed.
  notifications.requestPermissionsAsync.mockResolvedValue(GRANTED);
  return {
    sync,
    notifications,
    storedIdFor: (jobId) => storage.getItem(`versutus:routine-notification:${jobId}`),
    setState: (value) => {
      Object.defineProperty(reactNative.AppState, 'currentState', { value, configurable: true });
    },
  };
}

const GRANTED = { granted: true, status: 'granted', canAskAgain: false };
const DENIED = { granted: false, status: 'denied', canAskAgain: false };
const UNDETERMINED = { granted: false, status: 'undetermined', canAskAgain: true };

function job(id: string) {
  return { id, name: '[bot:scout] Morning briefing', schedule: '0 9 * * *' };
}

describe('the permission gate a routine re-arm goes through', () => {
  test('three routines re-armed at once with the app pocketed never ask the phone', async () => {
    const { sync, notifications, setState } = freshRoutineSync();
    setState('background');
    notifications.getPermissionsAsync.mockResolvedValue(UNDETERMINED);

    await Promise.all([sync.syncRoutineNotification(job('a')), sync.syncRoutineNotification(job('b')), sync.syncRoutineNotification(job('c'))]);

    // One read for three routines, and no dialog: Android 13+ cannot show one to
    // a pocketed app, so asking here spends the one chance to ask on a
    // permission nobody was shown.
    expect(notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  test('the same three routines ask once between them, from the foreground', async () => {
    const { sync, notifications, setState } = freshRoutineSync();
    setState('active');
    notifications.getPermissionsAsync.mockResolvedValue(UNDETERMINED);
    notifications.requestPermissionsAsync.mockResolvedValue(GRANTED);

    await Promise.all([sync.syncRoutineNotification(job('a')), sync.syncRoutineNotification(job('b')), sync.syncRoutineNotification(job('c'))]);

    // The gate is shared, so N concurrent jobs share ONE evaluation: one read
    // and one dialog between them, not one each.
    expect(notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    // The grant it produced is real work: all three notices are armed.
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(3);
  });

  test('a refusal is remembered, so the next re-arm neither reads nor asks', async () => {
    const { sync, notifications, setState } = freshRoutineSync();
    setState('active');
    notifications.getPermissionsAsync.mockResolvedValue(DENIED);
    notifications.requestPermissionsAsync.mockResolvedValue(GRANTED);

    await sync.syncRoutineNotification(job('a'));
    await sync.rearmRoutineNotifications([job('a'), job('b')]);

    // One read answers for the whole process until the refusal's TTL expires:
    // re-asking a settled permission is what the re-ask-per-routine did.
    expect(notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('re-arming one job from two places at once', () => {
  test('two overlapping re-arms leave the phone holding exactly one notice', async () => {
    const { sync, notifications, storedIdFor } = freshRoutineSync();
    notifications.getPermissionsAsync.mockResolvedValue(GRANTED);

    // The connect-time re-arm and a Bot Chat's own routine read, overlapping:
    // the second call is issued before the first has resolved.
    const first = sync.syncRoutineNotification(job('job-1'));
    const second = sync.syncRoutineNotification(job('job-1'));
    await Promise.all([first, second]);

    // Both passes did schedule (an edit re-arms), but the second retired the
    // one the first left behind — so the queue holds one notice, and it is the
    // one the mapping names. Before the chain, both passes read the mapping
    // while it was still empty and left the other's notice queued for good.
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
    expect([...notifications.__queue.keys()]).toEqual([await storedIdFor('job-1')]);
    expect(notifications.__queue.size).toBe(1);
  });

  test('the second re-arm waits for the first to finish, rather than interleaving with it', async () => {
    const { sync, notifications } = freshRoutineSync();
    notifications.getPermissionsAsync.mockResolvedValue(GRANTED);

    await Promise.all([
      sync.syncRoutineNotification(job('job-1')),
      sync.syncRoutineNotification(job('job-1')),
    ]);

    // The phone's own call order is the lock: the second arm is scheduled only
    // after the first one's identifier is on record, so no pass ever reads a
    // mapping the other is halfway through rewriting.
    const arms = notifications.__calls.filter((call) => call === 'schedule' || call.startsWith('cancel:'));
    expect(arms).toHaveLength(3);
    expect(arms[2]).toMatch(/^cancel:/);
  });

  test('a re-arm that cannot replace leaves the held notice exactly where it is', async () => {
    const { sync, notifications, storedIdFor } = freshRoutineSync();
    notifications.getPermissionsAsync.mockResolvedValue(GRANTED);
    await sync.syncRoutineNotification(job('job-1'));
    expect(notifications.__queue.size).toBe(1);

    // The phone refuses the replacement (here: a scheduler that throws). The
    // operator keeps the notice they hold rather than trading it for nothing.
    notifications.scheduleNotificationAsync.mockRejectedValueOnce(new Error('scheduler unavailable'));

    await sync.syncRoutineNotification(job('job-1'));

    expect(notifications.__queue.size).toBe(1);
    expect([...notifications.__queue.keys()]).toEqual([await storedIdFor('job-1')]);
  });

  test('a failed arm does not poison the chain for the next one', async () => {
    const { sync, notifications } = freshRoutineSync();
    notifications.getPermissionsAsync.mockResolvedValue(GRANTED);
    notifications.scheduleNotificationAsync.mockRejectedValueOnce(new Error('scheduler unavailable'));

    await expect(sync.syncRoutineNotification(job('job-1'))).resolves.toBeUndefined();
    await sync.syncRoutineNotification(job('job-1'));

    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
    expect(notifications.__queue.size).toBe(1);
  });
});

describe('reconciling the queue the OS is still holding', () => {
  test('an orphan from an earlier collision is retired and the live one kept', async () => {
    const { sync, notifications, storedIdFor } = freshRoutineSync();
    notifications.getPermissionsAsync.mockResolvedValue(GRANTED);
    await sync.syncRoutineNotification(job('job-1'));

    // A notice an earlier overlap left behind for the SAME job: nothing in the
    // mapping names it, so nothing would ever retire it.
    notifications.__queue.set('notif-orphan', 'job-1');

    await sync.reconcileRoutineNotices(['job-1']);

    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notif-orphan');
    expect(notifications.__queue.has('notif-orphan')).toBe(false);
    // The notice the mapping still names is the one that survives.
    expect([...notifications.__queue.keys()]).toEqual([await storedIdFor('job-1')]);
  });

  test("another Bot's live notice is left alone, and a read that never named it is safe", async () => {
    const { sync, notifications } = freshRoutineSync();
    notifications.getPermissionsAsync.mockResolvedValue(GRANTED);
    // A Bot Chat's routine read carries only that Bot's environment's jobs, so
    // a reconcile against it must not treat another Bot's queued notice as an
    // orphan.
    notifications.__queue.set('notif-other-bot', 'job-somewhere-else');

    await sync.reconcileRoutineNotices(['job-1']);

    expect(notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(notifications.__queue.has('notif-other-bot')).toBe(true);
  });

  test('a re-arm closes by retiring the orphans it can prove are orphans', async () => {
    const { sync, notifications, storedIdFor } = freshRoutineSync();
    notifications.getPermissionsAsync.mockResolvedValue(GRANTED);
    await sync.syncRoutineNotification(job('job-1'));
    notifications.__queue.set('notif-orphan', 'job-1');
    notifications.cancelScheduledNotificationAsync.mockClear();

    await sync.rearmRoutineNotifications([job('job-1')]);

    // The re-arm armed a fresh notice and then swept what no mapping named.
    expect(notifications.__queue.size).toBe(1);
    expect([...notifications.__queue.keys()]).toEqual([await storedIdFor('job-1')]);
    expect(notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notif-orphan');
  });

  test('a queue that cannot be read retires nothing and throws nothing', async () => {
    const { sync, notifications } = freshRoutineSync();
    notifications.getPermissionsAsync.mockResolvedValue(GRANTED);
    notifications.getAllScheduledNotificationsAsync.mockRejectedValue(new Error('tray unavailable'));

    await expect(sync.reconcileRoutineNotices(['job-1'])).resolves.toBeUndefined();
    await expect(sync.rearmRoutineNotifications([job('job-1')])).resolves.toBeUndefined();

    // The arm still landed — the reconcile is the last step, not a gate on it.
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });
});
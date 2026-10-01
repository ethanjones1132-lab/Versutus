// The permission gate every local notice goes through (`present`'s
// `ensurePermission`).
//
// It used to cache `granted === true` and nothing else, so a refusal re-asked
// the phone for permission on EVERY notice — and asked from the backgrounded
// state most notices are posted in, where Android 13+ cannot show the dialog at
// all. The phone is now read first: a grant is cached, a refusal is remembered
// for ten minutes, and the dialog is requested only from an undetermined state
// while the app is foregrounded, which is the one place it can be shown.

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(async () => 'notif-1'),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

type LocalNotifications = typeof import('@/lib/notifications/local');
type ReactNative = typeof import('react-native');

/**
 * A fresh copy of the module, because what is under test is module-level state:
 * the grant cached after the first notice, and the denial remembered after the
 * first refusal. Both must be re-established per case or a case inherits the
 * answer the previous one left behind — and the AppState the fresh copy reads
 * is a fresh object too, so it is set through here and not through an import.
 */
function freshLocal(): {
  local: LocalNotifications;
  read: jest.Mock;
  request: jest.Mock;
  schedule: jest.Mock;
  setState: (value: string) => void;
} {
  jest.resetModules();
  const notifications = jest.requireMock<{
    getPermissionsAsync: jest.Mock;
    requestPermissionsAsync: jest.Mock;
    scheduleNotificationAsync: jest.Mock;
  }>('expo-notifications');
  const reactNative = jest.requireActual<ReactNative>('react-native');
  const local = jest.requireActual<LocalNotifications>('@/lib/notifications/local');
  return {
    local,
    read: notifications.getPermissionsAsync,
    request: notifications.requestPermissionsAsync,
    schedule: notifications.scheduleNotificationAsync,
    setState: (value: string) => {
      Object.defineProperty(reactNative.AppState, 'currentState', { value, configurable: true });
    },
  };
}

/** The three permission states the phone can report, spelled out. */
const GRANTED = { granted: true, status: 'granted', canAskAgain: false };
const DENIED = { granted: false, status: 'denied', canAskAgain: false };
const UNDETERMINED = { granted: false, status: 'undetermined', canAskAgain: true };

/** One run-complete notice — the plainest of the posters. */
async function postNotice(local: LocalNotifications): Promise<void> {
  await local.notifyRunComplete('Run complete', 'wrote 3 files', 'run-7');
}

describe('local notice permission handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a refused permission is never re-asked for, on any notice after the first', async () => {
    const { local, read, request, schedule, setState } = freshLocal();
    setState('background');
    read.mockResolvedValue(DENIED);

    await postNotice(local);
    await postNotice(local);
    await postNotice(local);

    // Three notices, one read of the phone. The refusal is remembered, so the
    // per-notice re-ask is gone — and so is the dialog Android 13+ could not
    // have shown from the background anyway.
    expect(read).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  test('a phone that will not answer again is treated as denied, not asked again', async () => {
    const { local, read, request, setState } = freshLocal();
    setState('background');
    // canAskAgain false is the same final answer spelled the other way round.
    read.mockResolvedValue({ granted: false, status: 'undetermined', canAskAgain: false });

    await postNotice(local);

    expect(read).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  test('an undetermined permission is not asked for from the background', async () => {
    const { local, read, request, schedule, setState } = freshLocal();
    setState('background');
    read.mockResolvedValue(UNDETERMINED);

    await postNotice(local);

    // Android 13+ cannot show the dialog with the app pocketed, so asking here
    // spends the one chance to ask on a permission nobody was shown.
    expect(read).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  test('an undetermined permission is asked for once, when the app is foregrounded', async () => {
    const { local, read, request, schedule, setState } = freshLocal();
    setState('background');
    read.mockImplementation(async () => {
      // The operator brought the app forward while the phone was being read, so
      // this is the one moment a dialog could actually be shown. In the shipped
      // app the Settings screen is where permission is really asked for
      // (use-notification-preferences.ts:146) — from this poster it is reachable
      // only in this race.
      setState('active');
      return UNDETERMINED;
    });
    request.mockResolvedValue(GRANTED);

    await postNotice(local);
    await postNotice(local);

    // Asked once. The grant it produces is cached, so the second notice neither
    // re-reads the phone nor asks again — it is only the draw that stops, and
    // that is `present`'s own foreground rule, still standing.
    expect(request).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('three callers folded in the same tick share ONE evaluation of the gate', async () => {
    // NOTIF-03's shape reaches this gate too: a re-arm fanning out over every
    // routine calls it once per routine, all before the first answer has set the
    // cache. Each of them reading the phone and asking it for the dialog is N
    // native round trips and N chances to spend the one dialog.
    const { local, read, request, schedule, setState } = freshLocal();
    setState('background');
    read.mockImplementation(async () => {
      // The operator brought the app forward while the phone was being read, so
      // this is the one moment a dialog could actually be shown (the case above
      // does the same thing). Deferred so all three callers have already reached
      // the gate — the point of this case is what happens AFTER that.
      await Promise.resolve();
      setState('active');
      return UNDETERMINED;
    });
    request.mockResolvedValue(GRANTED);

    await Promise.all([postNotice(local), postNotice(local), postNotice(local)]);

    // One read, one dialog, between three callers — and the grant they share is
    // real work: all three notices are drawn.
    expect(read).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(3);
  });

  test('a grant is honoured, and is asked for nothing', async () => {
    const { local, read, request, schedule, setState } = freshLocal();
    setState('background');
    read.mockResolvedValue(GRANTED);

    await postNotice(local);

    expect(request).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('a foregrounded app draws nothing and never asks the phone at all', async () => {
    // `present` refuses before it reaches the permission gate, so this is the
    // shipped suppression rule, unchanged: nothing is read and no dialog is
    // raised for an app the operator is already looking at.
    const { local, read, request, schedule, setState } = freshLocal();
    setState('active');
    read.mockResolvedValue(UNDETERMINED);

    await postNotice(local);

    expect(read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  test('a phone that cannot answer at all posts nothing and throws nothing', async () => {
    const { local, read, request, schedule, setState } = freshLocal();
    setState('background');
    read.mockRejectedValue(new Error('notifications unavailable'));

    await expect(postNotice(local)).resolves.toBeUndefined();

    expect(request).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
});
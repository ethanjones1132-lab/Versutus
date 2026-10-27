// D3's weekly operator report (FUTURE-ITEMS.md §D3 Build 4/5): ONE weekly
// local notice, enabled from the scorecard surface, off by default. This
// suite pins both halves — the pure copy/flag/trigger rules in
// `weekly-report-schedule.ts` (no mocks needed for those) and the stored
// bookkeeping in `weekly-report.ts`, whose only scheduler is the mocked
// expo-notifications API.
//
// The honesty rules the copy has to keep: the notice announces a report that
// is READY and counts nothing, because a scheduled notice fires at its
// scheduled time whether or not the gateway ran and cannot know the week's
// figures while the app is closed.

import {
  isWeeklyReportEnabled,
  weeklyReportOptInHolds,
  weeklyReportRefusedBy,
  weeklyReportRefusalCopy,
  weeklyReportTrigger,
  WEEKLY_REPORT_NOTICE_BODY,
  WEEKLY_REPORT_NOTICE_DATA_KIND,
  WEEKLY_REPORT_NOTICE_KEY,
  WEEKLY_REPORT_NOTICE_TITLE,
  WEEKLY_REPORT_OPT_IN_KEY,
  WEEKLY_REPORT_OPT_IN_LABEL,
  WEEKLY_REPORT_OPT_IN_ON,
  WEEKLY_REPORT_OPT_IN_SUMMARY,
  weeklyReportNoticeData,
} from '@/lib/notifications/weekly-report-schedule';

// The mock replaces the module, so the trigger-type constants the pure
// mapping module imports must be spelled here — expo numbers them
// SchedulableTriggerInputTypes = { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' }.
jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' },
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (key: string) => store[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete store[key];
    }),
  };
});

import * as Notifications from 'expo-notifications';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadWeeklyReportOptIn,
  readWeeklyReportOptIn,
  setWeeklyReportOptIn,
  WEEKLY_REPORT_PENDING_NOTICE_KEY,
} from '@/lib/notifications/weekly-report';
import { routeForTap } from '@/lib/notifications/tap-route';
import { keyValueStorage } from '@/lib/storage/key-value';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;
const mockCancel = Notifications.cancelScheduledNotificationAsync as jest.Mock;

/** Whatever identifier this device currently holds for the weekly notice. */
async function heldId(): Promise<string | null> {
  return keyValueStorage.getItem(WEEKLY_REPORT_NOTICE_KEY);
}

/** Whether the device holds an opt-in, as the stored flag has it. */
async function storedOptIn(): Promise<string | null> {
  return keyValueStorage.getItem(WEEKLY_REPORT_OPT_IN_KEY);
}

describe('the opt-in flag is a stored state, and absent is off', () => {
  test('only the stored on value opts in — nothing else does', () => {
    expect(isWeeklyReportEnabled(WEEKLY_REPORT_OPT_IN_ON)).toBe(true);
    expect(isWeeklyReportEnabled(null)).toBe(false);
    expect(isWeeklyReportEnabled('')).toBe(false);
    expect(isWeeklyReportEnabled('off')).toBe(false);
    expect(isWeeklyReportEnabled('true')).toBe(false);
    expect(isWeeklyReportEnabled('ON')).toBe(false);
  });

  test('a device that never opted in holds no opt-in', async () => {
    await expect(loadWeeklyReportOptIn()).resolves.toBe(false);
    await expect(storedOptIn()).resolves.toBeNull();
  });
});

describe('the notice the opt-in promises', () => {
  test('the fire is a WEEKLY trigger on Monday morning', () => {
    // Expo numbers weekdays 1 (Sunday) through 7 (Saturday), so Monday is 2.
    expect(weeklyReportTrigger()).toEqual({ type: 'weekly', weekday: 2, hour: 9, minute: 0 });
  });

  test('the copy announces a report that is ready, and counts nothing', () => {
    expect(WEEKLY_REPORT_NOTICE_TITLE).toBe('Your weekly agent report is ready');
    // No digit anywhere: a scheduled notice cannot know the week's numbers,
    // so it must not appear to.
    expect(`${WEEKLY_REPORT_NOTICE_TITLE} ${WEEKLY_REPORT_NOTICE_BODY}`).not.toMatch(/\d/);
    expect(`${WEEKLY_REPORT_NOTICE_TITLE} ${WEEKLY_REPORT_NOTICE_BODY}`).toMatch(/open versutus/i);
  });

  test('the opt-in line says it is a local notice, and claims no push', () => {
    const copy = `${WEEKLY_REPORT_OPT_IN_LABEL} ${WEEKLY_REPORT_OPT_IN_SUMMARY}`;

    expect(copy).toMatch(/local/i);
    expect(copy).not.toMatch(/push/i);
    // The day the copy names is the day the trigger fires.
    expect(WEEKLY_REPORT_OPT_IN_SUMMARY).toContain('Monday');
    expect(weeklyReportTrigger().weekday).toBe(2);
    expect(copy).not.toMatch(/\d/);
  });
});

describe('a refused opt-in says why', () => {
  test('only a held notice reads as on, so a refusal always snaps the switch back', () => {
    expect(weeklyReportOptInHolds({ state: 'on' })).toBe(true);
    expect(weeklyReportOptInHolds({ state: 'off' })).toBe(false);
    expect(weeklyReportOptInHolds({ state: 'refused', reason: 'permission' })).toBe(false);
    expect(weeklyReportOptInHolds({ state: 'refused', reason: 'schedule' })).toBe(false);
  });

  test('a refusal carries its reason; nothing else names one', () => {
    expect(weeklyReportRefusedBy({ state: 'refused', reason: 'permission' })).toBe('permission');
    expect(weeklyReportRefusedBy({ state: 'refused', reason: 'schedule' })).toBe('schedule');
    expect(weeklyReportRefusedBy({ state: 'on' })).toBeNull();
    expect(weeklyReportRefusedBy({ state: 'off' })).toBeNull();
  });

  test('a refused permission names where to turn notifications back on, claims no push', () => {
    const copy = weeklyReportRefusalCopy('permission');

    expect(copy).toMatch(/notifications are off/i);
    expect(copy).toMatch(/settings/i);
    expect(copy).not.toMatch(/push/i);
    expect(copy).not.toMatch(/\d/);
    // The same line covers a permission revoked under a notice the OS still
    // holds, so it must not claim nothing was scheduled: that notice is on the
    // queue, and the tray's refusal is the only thing left to name.
    expect(copy).not.toMatch(/schedul/i);
  });

  test('a schedule that could not be placed never blames the permission', () => {
    const copy = weeklyReportRefusalCopy('schedule');

    // Notifications were granted and the schedule still did not land, so this
    // line must not send the operator to Settings over nothing.
    expect(copy).not.toMatch(/settings/i);
    expect(copy).not.toMatch(/notifications are off/i);
    expect(copy).not.toBe(weeklyReportRefusalCopy('permission'));
  });
});

describe('opting in schedules exactly one weekly notice', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await keyValueStorage.removeItem(WEEKLY_REPORT_NOTICE_KEY);
    await keyValueStorage.removeItem(WEEKLY_REPORT_OPT_IN_KEY);
    mockSchedule.mockResolvedValue('notif-1');
    mockCancel.mockResolvedValue(undefined);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  });

  test('a fresh install opts into nothing and schedules nothing', async () => {
    await expect(loadWeeklyReportOptIn()).resolves.toBe(false);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(heldId()).resolves.toBeNull();
  });

  test('opting in schedules one weekly notice and stores its identifier', async () => {
    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.trigger).toEqual({ type: 'weekly', weekday: 2, hour: 9, minute: 0 });
    expect(request.content.title).toBe(WEEKLY_REPORT_NOTICE_TITLE);
    expect(request.content.body).toBe(WEEKLY_REPORT_NOTICE_BODY);
    await expect(heldId()).resolves.toBe('notif-1');
    await expect(storedOptIn()).resolves.toBe(WEEKLY_REPORT_OPT_IN_ON);
    // The flag and the notice agree: what the toggle shows is what the phone holds.
    await expect(loadWeeklyReportOptIn()).resolves.toBe(true);
  });

  test('the notice carries its tap marker, and the marker is the route', async () => {
    await setWeeklyReportOptIn(true);

    const request = mockSchedule.mock.calls[0][0];
    // Without the payload a tap on the report is an unrecognized notice; with
    // it, the tap opens the scorecard surface, which reads this device's runs
    // when it opens (D3 Build 4) — and the marker names no id, because the
    // destination takes no argument.
    expect(request.content.data).toEqual(weeklyReportNoticeData());
    expect(request.content.data.kind).toBe(WEEKLY_REPORT_NOTICE_DATA_KIND);
    expect(routeForTap(request.content.data)).toEqual({ kind: 'weekly-report' });
  });

  test('a second opt-in replaces the notice the first one holds, never stacks it', async () => {
    mockSchedule.mockResolvedValueOnce('notif-a').mockResolvedValueOnce('notif-b');

    await setWeeklyReportOptIn(true);
    await setWeeklyReportOptIn(true);

    expect(mockSchedule).toHaveBeenCalledTimes(2);
    // The held notice is retired only once a replacement landed, so exactly
    // one notice is scheduled and the mapping holds only the live id.
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith('notif-a');
    expect(mockCancel).not.toHaveBeenCalledWith('notif-b');
    await expect(heldId()).resolves.toBe('notif-b');
  });

  test('opting out cancels the identifier it held and clears the flag', async () => {
    await setWeeklyReportOptIn(true);

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect(mockCancel).toHaveBeenCalledWith('notif-1');
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
    await expect(loadWeeklyReportOptIn()).resolves.toBe(false);
  });

  test('opting out on a device that never opted in schedules nothing', async () => {
    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(heldId()).resolves.toBeNull();
  });

  test('a denied permission names the refusal it met, and holds no opt-in it cannot honour', async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({
      state: 'refused',
      reason: 'permission',
    });

    expect(mockSchedule).not.toHaveBeenCalled();
    await expect(heldId()).resolves.toBeNull();
    // Nothing promises a notice that is not there: the surface reads off.
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('a declined opt-in is distinguishable from a device that never asked', async () => {
    // The untouched read: no notice, and no refusal to name either.
    await expect(loadWeeklyReportOptIn()).resolves.toBe(false);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

    const refused = await setWeeklyReportOptIn(true);

    // The operator asked and the phone said no — a different answer from the
    // one a device that never asked gives, which is the whole point of the line.
    expect(refused).toEqual({ state: 'refused', reason: 'permission' });
    expect(weeklyReportOptInHolds(refused)).toBe(false);
    expect(weeklyReportRefusedBy(refused)).toBe('permission');
    expect(refused).not.toEqual({ state: 'off' });
  });

  test('a schedule that throws names its own refusal, and never rejects', async () => {
    mockSchedule.mockRejectedValue(new Error('scheduler unavailable'));

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({
      state: 'refused',
      reason: 'schedule',
    });
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('a schedule that returns no identifier stores none behind a phantom id', async () => {
    mockSchedule.mockResolvedValue(null);

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({
      state: 'refused',
      reason: 'schedule',
    });
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('an opt-in that cannot be scheduled leaves an already-held notice alone', async () => {
    await setWeeklyReportOptIn(true);
    expect(mockCancel).not.toHaveBeenCalled();

    // The operator's reminder is already waiting; a declined re-opt-in must
    // not trade it for nothing — so the state is the held one, and there is
    // no refusal to explain.
    mockSchedule.mockRejectedValue(new Error('scheduler unavailable'));
    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });

    expect(mockCancel).not.toHaveBeenCalled();
    await expect(heldId()).resolves.toBe('notif-1');
  });

  test('a store that cannot be read holds no opt-in, and fails closed', async () => {
    // The key-value wrapper reads through AsyncStorage on native, and that is
    // the call a locked store would throw from.
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('store locked'));

    await expect(loadWeeklyReportOptIn()).resolves.toBe(false);
  });
});

describe('a permission revoked after the opt-in does not read as on', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await keyValueStorage.removeItem(WEEKLY_REPORT_NOTICE_KEY);
    await keyValueStorage.removeItem(WEEKLY_REPORT_OPT_IN_KEY);
    mockSchedule.mockResolvedValue('notif-1');
    mockCancel.mockResolvedValue(undefined);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  });

  test('a granted permission on a held notice still reads on', async () => {
    await setWeeklyReportOptIn(true);
    expect(mockSchedule).toHaveBeenCalledTimes(1);

    await expect(readWeeklyReportOptIn()).resolves.toEqual({ state: 'on' });
  });

  test('a permission turned off in Settings reads refused, and names that reason', async () => {
    await setWeeklyReportOptIn(true);
    mockSchedule.mockClear();
    mockCancel.mockClear();
    // The operator opted in, then revoked notifications in the OS Settings:
    // the flag and the identifier are still here, and the tray will not show
    // what they stand for.
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

    const state = await readWeeklyReportOptIn();

    expect(state).toEqual({ state: 'refused', reason: 'permission' });
    // The switch snaps back, and the module's own line — the Settings one —
    // explains it, exactly as a declined opt-in does.
    expect(weeklyReportOptInHolds(state)).toBe(false);
    expect(weeklyReportRefusedBy(state)).toBe('permission');
    expect(weeklyReportRefusalCopy('permission')).toMatch(/settings/i);
  });

  test('the read schedules nothing and cancels nothing', async () => {
    await setWeeklyReportOptIn(true);
    mockSchedule.mockClear();
    mockCancel.mockClear();
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

    await readWeeklyReportOptIn();

    // A read is a read: the held notice is exactly where it was, so restoring
    // the permission restores the report instead of losing it.
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(heldId()).resolves.toBe('notif-1');
    await expect(storedOptIn()).resolves.toBe(WEEKLY_REPORT_OPT_IN_ON);
  });

  test('the read never asks for the permission — only the opt-in attempt does', async () => {
    await setWeeklyReportOptIn(true);
    (Notifications.requestPermissionsAsync as jest.Mock).mockClear();

    await readWeeklyReportOptIn();

    // Opening the tab must not fire a system dialog the operator never asked
    // for: the mount read is `getPermissionsAsync`, which has no user-facing
    // effect.
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test('a device that never opted in is never asked, and reads off', async () => {
    await expect(readWeeklyReportOptIn()).resolves.toEqual({ state: 'off' });

    // Nothing off a held flag is asked: a device with no opt-in has no notice
    // whose permission could matter.
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  test('a permission this platform cannot answer names no reason at all', async () => {
    await setWeeklyReportOptIn(true);
    // What a platform with no notification permission module does: expo
    // rejects with an UnavailabilityError rather than answering.
    (Notifications.getPermissionsAsync as jest.Mock).mockRejectedValue(
      new Error('not available on this platform'),
    );

    const state = await readWeeklyReportOptIn();

    // Nothing was read, so nothing is blamed — the surface must not send the
    // operator to Settings over a fact this device never reported. The state
    // is the one this device's own record holds.
    expect(state).toEqual({ state: 'on' });
    expect(weeklyReportRefusedBy(state)).toBeNull();
  });

  test('a second read after a revocation answers refused too, because the read is repeatable', async () => {
    await setWeeklyReportOptIn(true);
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

    // The section re-reads this on every focus, so one session reads the same
    // device many times over: the second read must answer the device, never a
    // cached first answer.
    await expect(readWeeklyReportOptIn()).resolves.toEqual({
      state: 'refused',
      reason: 'permission',
    });
    await expect(readWeeklyReportOptIn()).resolves.toEqual({
      state: 'refused',
      reason: 'permission',
    });
  });

  test('a focus read follows the device, so restoring the permission restores the report', async () => {
    await setWeeklyReportOptIn(true);

    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    await expect(readWeeklyReportOptIn()).resolves.toEqual({
      state: 'refused',
      reason: 'permission',
    });

    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    await expect(readWeeklyReportOptIn()).resolves.toEqual({ state: 'on' });

    // Repainting the switch is all a focus read does: it schedules nothing,
    // retires nothing and asks for nothing, so the notice the operator holds
    // is exactly where the one opt-in put it.
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    await expect(heldId()).resolves.toBe('notif-1');
  });
});

/**
 * The defect this suite now pins (QUALITY-SCAN 2026-10-11, scan985–989): a
 * scheduled notice must never outlive the bookkeeping that names it, and the
 * bookkeeping must never stop naming a notice that is still scheduled.
 *
 * The mocked scheduler is modelled as an ACTIVE SET, so each assertion can
 * check what the OS queue holds — not only the identifier the module stored.
 * That distinction is the whole defect: the old code could restore a mapping
 * to a notice it had never cancelled while the replacement it could not cancel
 * was still waiting, unreachable by any later opt-out.
 */
describe('the notice transaction never loses a live notice', () => {
  const active = new Set<string>();
  let nextId = 0;
  let rejectFlagWrite = false;
  let rejectMappingWrite = false;
  let rejectEveryWrite = false;
  let rejectPrimaryRead = false;
  let rejectPendingRead = false;
  let refusedCancels = new Map<string, number>();
  let readSpy: jest.SpyInstance;
  let writeSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    active.clear();
    nextId = 0;
    rejectFlagWrite = false;
    rejectMappingWrite = false;
    rejectEveryWrite = false;
    rejectPrimaryRead = false;
    rejectPendingRead = false;
    refusedCancels = new Map();

    await keyValueStorage.removeItem(WEEKLY_REPORT_NOTICE_KEY);
    await keyValueStorage.removeItem(WEEKLY_REPORT_OPT_IN_KEY);
    await keyValueStorage.removeItem(WEEKLY_REPORT_PENDING_NOTICE_KEY);

    // Every schedule lands on the fake OS queue under a fresh id, exactly as
    // scheduleNotificationAsync resolves with the identifier it created.
    mockSchedule.mockImplementation(async () => {
      nextId += 1;
      const identifier = `notif-${nextId}`;
      active.add(identifier);
      return identifier;
    });
    // `refusedCancels` is how many times the phone refuses one cancellation;
    // a resolved cancel removes the notice from the queue, like expo does even
    // when the identifier names nothing any more.
    mockCancel.mockImplementation(async (identifier: string) => {
      const remaining = refusedCancels.get(identifier) ?? 0;
      if (remaining > 0) {
        refusedCancels.set(identifier, remaining - 1);
        throw new Error(`cannot cancel ${identifier}`);
      }
      active.delete(identifier);
    });

    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });

    // The injected failures are keyed by storage key, never by call order, so
    // a test names the read or write it refuses without depending on the
    // module's internal access sequence.
    const read = keyValueStorage.getItem.bind(keyValueStorage);
    readSpy = jest.spyOn(keyValueStorage, 'getItem').mockImplementation(async (key) => {
      if (rejectPrimaryRead && key === WEEKLY_REPORT_NOTICE_KEY) {
        rejectPrimaryRead = false;
        throw new Error('store locked');
      }
      if (rejectPendingRead && key === WEEKLY_REPORT_PENDING_NOTICE_KEY) {
        rejectPendingRead = false;
        throw new Error('store locked');
      }
      return read(key);
    });

    const write = keyValueStorage.setItem.bind(keyValueStorage);
    writeSpy = jest
      .spyOn(keyValueStorage, 'setItem')
      .mockImplementation(async (key, value) => {
        if (rejectEveryWrite) throw new Error('store locked');
        if (rejectFlagWrite && key === WEEKLY_REPORT_OPT_IN_KEY) {
          rejectFlagWrite = false;
          throw new Error('store locked');
        }
        if (rejectMappingWrite && key === WEEKLY_REPORT_NOTICE_KEY) {
          rejectMappingWrite = false;
          throw new Error('store locked');
        }
        await write(key, value);
      });
  });

  afterEach(() => {
    // Only these spies are ours to undo. The module-level jest.fn()s above
    // keep their storage implementations for the next case.
    readSpy?.mockRestore();
    writeSpy?.mockRestore();
  });

  test('a fresh opt-in whose flag write fails schedules nothing that outlives the attempt', async () => {
    rejectFlagWrite = true;

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({
      state: 'refused',
      reason: 'schedule',
    });

    // The attempt's own notice was rolled back: with no consent stored, no
    // Monday notice may stay on the queue, and nothing may still name one.
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect([...active]).toEqual([]);
    expect(mockCancel).toHaveBeenCalledWith('notif-1');
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
    await expect(keyValueStorage.getItem(WEEKLY_REPORT_PENDING_NOTICE_KEY)).resolves.toBeNull();
  });

  test('a replacement that cannot be scheduled leaves the held notice exactly where it was', async () => {
    await setWeeklyReportOptIn(true);
    expect([...active]).toEqual(['notif-1']);

    mockSchedule.mockRejectedValueOnce(new Error('scheduler unavailable'));

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });

    // The held reminder is still the queue's only notice and still the one the
    // mapping names; a declined replacement retires nothing and stacks nothing.
    expect([...active]).toEqual(['notif-1']);
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(heldId()).resolves.toBe('notif-1');
    await expect(storedOptIn()).resolves.toBe(WEEKLY_REPORT_OPT_IN_ON);
  });

  test('a replacement whose old-notice cancel is refused keeps both notices named', async () => {
    await setWeeklyReportOptIn(true);
    expect([...active]).toEqual(['notif-1']);

    refusedCancels.set('notif-1', 1);

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });

    // The replacement landed and is the mapping; the notice it superseded
    // could not be retired, so it stays scheduled AND stays recorded.
    expect([...active].sort()).toEqual(['notif-1', 'notif-2']);
    await expect(heldId()).resolves.toBe('notif-2');
    expect(mockCancel).toHaveBeenCalledWith('notif-1');

    // With the phone accepting cancellation again, one opt-out retires the
    // replacement and the survivor it could not retire before.
    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('a replacement whose flag write fails keeps the held notice and the survivor it could not cancel', async () => {
    await setWeeklyReportOptIn(true);
    expect([...active]).toEqual(['notif-1']);
    // The seeded state the reviewer reproduced: a held notice and a stored
    // opt-in. The replacement's own cancellation is refused exactly once.
    rejectFlagWrite = true;
    refusedCancels.set('notif-2', 1);

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });

    // The failed attempt may not lose notif-2: it is still on the OS queue, so
    // it must still have a name. The mapping stays on the notice the operator
    // already held rather than being repointed at a notice it cannot retire.
    expect([...active].sort()).toEqual(['notif-1', 'notif-2']);
    await expect(heldId()).resolves.toBe('notif-1');
    expect(mockCancel).toHaveBeenCalledWith('notif-2');

    // Storage and cancellation recover; one opt-out retires every tracked
    // live notice, including the failed rollback's survivor.
    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('a replacement whose mapping write fails keeps both notices named', async () => {
    await setWeeklyReportOptIn(true);
    expect([...active]).toEqual(['notif-1']);

    // Consent is already stored, and the new notice is in the pending list, so
    // the only refused write is the promotion to the mapping. The device still
    // holds what the flag says, but the mapping must keep naming a live notice.
    rejectMappingWrite = true;

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });

    expect([...active].sort()).toEqual(['notif-1', 'notif-2']);
    await expect(heldId()).resolves.toBe('notif-1');
    await expect(storedOptIn()).resolves.toBe(WEEKLY_REPORT_OPT_IN_ON);

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('an opt-in that cannot read its own record schedules nothing and asks for nothing', async () => {
    rejectPrimaryRead = true;

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({
      state: 'refused',
      reason: 'schedule',
    });

    // An attempt that cannot see what the device holds must not stack a second
    // notice on it, prompt for permission on a guess, or overwrite the record.
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect([...active]).toEqual([]);
  });

  test('an opt-in that cannot read the pending list leaves the held notice alone', async () => {
    await setWeeklyReportOptIn(true);
    expect([...active]).toEqual(['notif-1']);

    rejectPendingRead = true;

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });

    // The held notice is still exactly the one the device has, so a record it
    // could not read must stop the replacement rather than be overwritten.
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect([...active]).toEqual(['notif-1']);
    await expect(heldId()).resolves.toBe('notif-1');
  });

  test('an opt-in the store cannot record schedules nothing it cannot name', async () => {
    rejectEveryWrite = true;

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({
      state: 'refused',
      reason: 'schedule',
    });

    // Without a place to record the identifier, the attempt may keep no
    // notice: it is undone in the same call that created it.
    expect([...active]).toEqual([]);
    expect(mockCancel).toHaveBeenCalledWith('notif-1');
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('a notice no store could record is still retired by the next opt-out', async () => {
    rejectEveryWrite = true;
    refusedCancels.set('notif-1', 1);

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({
      state: 'refused',
      reason: 'schedule',
    });
    // Two failures at once: no key would take the id and the phone refused to
    // cancel it. The notice is live, so the module must still remember it.
    expect([...active]).toEqual(['notif-1']);

    rejectEveryWrite = false;
    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('a store that cannot be read never forgets the identifiers it could not name', async () => {
    await setWeeklyReportOptIn(true);
    // A survivor an earlier failed replacement is holding, recorded durably.
    await keyValueStorage.setItem(
      WEEKLY_REPORT_PENDING_NOTICE_KEY,
      JSON.stringify(['notif-survivor']),
    );
    active.add('notif-survivor');

    // Both records refuse the read, so this call cannot name a single notice.
    rejectPrimaryRead = true;
    rejectPendingRead = true;

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    // Nothing was cancelled or deleted on a guess: both ids are still on the
    // queue and both records survive, so a later opt-out can retire them.
    expect([...active].sort()).toEqual(['notif-1', 'notif-survivor']);
    await expect(heldId()).resolves.toBe('notif-1');
    await expect(keyValueStorage.getItem(WEEKLY_REPORT_PENDING_NOTICE_KEY)).resolves.toBe(
      JSON.stringify(['notif-survivor']),
    );

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
  });

  test('a corrupt pending list is repaired rather than blocking the toggle', async () => {
    await setWeeklyReportOptIn(true);
    await keyValueStorage.setItem(WEEKLY_REPORT_PENDING_NOTICE_KEY, 'not json');

    // A value this module never wrote names nothing it can recover, so it may
    // be replaced; leaving it in place would refuse every later attempt.
    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect([...active]).toEqual([]);
    await expect(keyValueStorage.getItem(WEEKLY_REPORT_PENDING_NOTICE_KEY)).resolves.toBeNull();
  });

  test('an opt-out whose cancel is refused keeps the identifier so a later opt-out retires it', async () => {
    await setWeeklyReportOptIn(true);
    refusedCancels.set('notif-1', 1);

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    // The switch honours the operator's ask, but the notice is still live, so
    // its identity may not be dropped: the next opt-out has to be able to try.
    expect([...active]).toEqual(['notif-1']);
    await expect(heldId()).resolves.toBe('notif-1');
    await expect(storedOptIn()).resolves.toBeNull();

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
  });

  test('a device whose state holds only the older single identifier still opts out', async () => {
    // What an older build wrote: one bare id under the notice key, no list.
    await keyValueStorage.setItem(WEEKLY_REPORT_NOTICE_KEY, 'notif-legacy');
    await keyValueStorage.setItem(WEEKLY_REPORT_OPT_IN_KEY, WEEKLY_REPORT_OPT_IN_ON);
    active.add('notif-legacy');

    await expect(loadWeeklyReportOptIn()).resolves.toBe(true);
    await expect(readWeeklyReportOptIn()).resolves.toEqual({ state: 'on' });

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });

    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
  });

  test('concurrent opt-ins keep every live identifier reachable by opt-out', async () => {
    await Promise.all([setWeeklyReportOptIn(true), setWeeklyReportOptIn(true)]);
    expect([...active]).toEqual(['notif-2']);

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });
    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
  });

  test('an opt-out during scheduling waits for the identifier and retires it', async () => {
    let releaseSchedule!: () => void;
    let enteredSchedule!: () => void;
    const parked = new Promise<void>((resolve) => { releaseSchedule = resolve; });
    const entered = new Promise<void>((resolve) => { enteredSchedule = resolve; });
    mockSchedule.mockImplementationOnce(async () => {
      enteredSchedule();
      await parked;
      active.add('notif-1');
      return 'notif-1';
    });
    const enable = setWeeklyReportOptIn(true);
    await entered;
    const disable = setWeeklyReportOptIn(false);
    releaseSchedule();

    await expect(Promise.all([enable, disable])).resolves.toEqual([
      { state: 'on' }, { state: 'off' },
    ]);
    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('the successful lifecycle schedules one notice, replaces it once, and retires it', async () => {
    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });
    expect([...active]).toEqual(['notif-1']);
    await expect(heldId()).resolves.toBe('notif-1');

    await expect(setWeeklyReportOptIn(true)).resolves.toEqual({ state: 'on' });
    expect([...active]).toEqual(['notif-2']);
    await expect(heldId()).resolves.toBe('notif-2');

    await expect(setWeeklyReportOptIn(false)).resolves.toEqual({ state: 'off' });
    expect([...active]).toEqual([]);
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
    await expect(keyValueStorage.getItem(WEEKLY_REPORT_PENDING_NOTICE_KEY)).resolves.toBeNull();
  });
});

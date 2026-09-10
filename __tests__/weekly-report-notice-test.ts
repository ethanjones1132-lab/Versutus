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
  weeklyReportTrigger,
  WEEKLY_REPORT_NOTICE_BODY,
  WEEKLY_REPORT_NOTICE_KEY,
  WEEKLY_REPORT_NOTICE_TITLE,
  WEEKLY_REPORT_OPT_IN_KEY,
  WEEKLY_REPORT_OPT_IN_LABEL,
  WEEKLY_REPORT_OPT_IN_ON,
  WEEKLY_REPORT_OPT_IN_SUMMARY,
} from '@/lib/notifications/weekly-report-schedule';

// The mock replaces the module, so the trigger-type constants the pure
// mapping module imports must be spelled here — expo numbers them
// SchedulableTriggerInputTypes = { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' }.
jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' },
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
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
  setWeeklyReportOptIn,
} from '@/lib/notifications/weekly-report';
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
    await expect(setWeeklyReportOptIn(true)).resolves.toBe(true);

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

    await expect(setWeeklyReportOptIn(false)).resolves.toBe(false);

    expect(mockCancel).toHaveBeenCalledWith('notif-1');
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
    await expect(loadWeeklyReportOptIn()).resolves.toBe(false);
  });

  test('opting out on a device that never opted in schedules nothing', async () => {
    await expect(setWeeklyReportOptIn(false)).resolves.toBe(false);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(heldId()).resolves.toBeNull();
  });

  test('a denied permission holds no opt-in it cannot honour', async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

    await expect(setWeeklyReportOptIn(true)).resolves.toBe(false);

    expect(mockSchedule).not.toHaveBeenCalled();
    await expect(heldId()).resolves.toBeNull();
    // Nothing promises a notice that is not there: the surface reads off.
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('a schedule that throws holds no opt-in either, and never rejects', async () => {
    mockSchedule.mockRejectedValue(new Error('scheduler unavailable'));

    await expect(setWeeklyReportOptIn(true)).resolves.toBe(false);
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('a schedule that returns no identifier stores none behind a phantom id', async () => {
    mockSchedule.mockResolvedValue(null);

    await expect(setWeeklyReportOptIn(true)).resolves.toBe(false);
    await expect(heldId()).resolves.toBeNull();
    await expect(storedOptIn()).resolves.toBeNull();
  });

  test('an opt-in that cannot be scheduled leaves an already-held notice alone', async () => {
    await setWeeklyReportOptIn(true);
    expect(mockCancel).not.toHaveBeenCalled();

    // The operator's reminder is already waiting; a declined re-opt-in must
    // not trade it for nothing.
    mockSchedule.mockRejectedValue(new Error('scheduler unavailable'));
    await expect(setWeeklyReportOptIn(true)).resolves.toBe(true);

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

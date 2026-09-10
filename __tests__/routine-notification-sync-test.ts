import { AppState } from 'react-native';

import {
  cancelRoutineNotification,
  syncRoutineNotification,
  // sibling of local.ts — immediate notices stay there, untouched
} from '@/lib/notifications/routine-sync';

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
import { keyValueStorage } from '@/lib/storage/key-value';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;
const mockCancel = Notifications.cancelScheduledNotificationAsync as jest.Mock;

// Present() suppresses foregrounded posts through AppState for the immediate
// notices; a scheduled routine notice must schedule regardless, so the tests
// pin the state to 'background' and one case flips it to prove that.
const originalStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

function setAppState(value: string): void {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
}

/** Whatever identifier is currently persisted for one routine job. */
async function storedIdFor(jobId: string): Promise<string | null> {
  return keyValueStorage.getItem(`versutus:routine-notification:${jobId}`);
}

const dailyJob = {
  id: 'job-1',
  name: '[bot:scout] Morning briefing',
  schedule: '0 9 * * *',
};

// The fire the gateway reported for the unmappable-cadence fixture. A literal
// calendar instant makes this suite expire: `cronToTrigger` refuses a fire
// that is not still ahead of now, so the day the machine clock passes the
// fixture it goes red for reasons that have nothing to do with the change
// under test. The far end of the range is therefore pinned past every clock,
// the same way the re-arm suite pins its own.
const NEXT_FIRE = '2999-01-01T09:00:00.000Z';

const complexJob = {
  id: 'job-2',
  name: '[bot:scout] Minute sweep',
  schedule: '*/5 * * * *',
  nextRunAt: NEXT_FIRE,
};

// A decline can only be exercised before any case in this file grants the
// permission: `ensurePermission` caches ONE granted answer for the life of the
// process, so this suite sits ABOVE the granted-permission suite below and
// never asks for a grant. Nothing is scheduled here — the point is what the
// sync does NOT do when the phone refuses.
describe('a phone that declines the schedule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    mockCancel.mockResolvedValue(undefined);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  });

  test('a first sync the phone declines stores no identifier', async () => {
    await syncRoutineNotification(dailyJob);

    expect(mockSchedule).not.toHaveBeenCalled();
    await expect(storedIdFor('job-1')).resolves.toBeNull();
  });

  test('a held notice survives a re-sync the phone declines', async () => {
    // The phone already holds this job's notice — the persisted mapping is the
    // identifier it was scheduled under.
    await keyValueStorage.setItem('versutus:routine-notification:job-7', 'notif-held');
    mockCancel.mockClear();

    // Permission stays refused, so the replacement never lands and the held
    // notice must not be retired for it: no identifier was ever stored for a
    // replacement that does not exist.
    await syncRoutineNotification({ ...dailyJob, id: 'job-7' });

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(storedIdFor('job-7')).resolves.toBe('notif-held');
  });
});

describe('routine notification sync/cancel bookkeeping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    mockSchedule.mockResolvedValue('notif-1');
    mockCancel.mockResolvedValue(undefined);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('a daily routine schedules one future-dated local notice with honest due copy', async () => {
    await syncRoutineNotification(dailyJob);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.trigger).toEqual({ type: 'daily', hour: 9, minute: 0 });
    expect(request.content.title).toBe('Morning briefing is due');
    expect(request.content.data).toEqual({ kind: 'routine-due', jobId: 'job-1', botId: 'scout' });
    await expect(storedIdFor('job-1')).resolves.toBe('notif-1');
  });

  test('syncing twice over an existing notice replaces it — one identifier survives', async () => {
    mockSchedule.mockResolvedValueOnce('notif-a').mockResolvedValueOnce('notif-b');

    await syncRoutineNotification(dailyJob);
    await syncRoutineNotification(dailyJob);

    // The first schedule's identifier is cancelled so an edit leaves exactly
    // one scheduled notification, not two firing copies; the mapping now
    // holds only the live id.
    expect(mockCancel).toHaveBeenCalledWith('notif-a');
    expect(mockCancel).not.toHaveBeenCalledWith('notif-b');
    await expect(storedIdFor('job-1')).resolves.toBe('notif-b');
  });

  test('cancel cancels the scheduled id and empties the mapping', async () => {
    await syncRoutineNotification(dailyJob);

    await cancelRoutineNotification('job-1');

    expect(mockCancel).toHaveBeenCalledWith('notif-1');
    await expect(storedIdFor('job-1')).resolves.toBeNull();
  });

  test('a paused routine schedules nothing and holds no identifier', async () => {
    await syncRoutineNotification({ ...dailyJob, paused: true });

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(storedIdFor('job-1')).resolves.toBeNull();
  });

  test('a paused routine replaces an earlier scheduled notice', async () => {
    await syncRoutineNotification(dailyJob);
    mockSchedule.mockClear();

    await syncRoutineNotification({ ...dailyJob, paused: true });

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith('notif-1');
    await expect(storedIdFor('job-1')).resolves.toBeNull();
  });

  test('an unmappable cron takes the one-shot at the next fire the gateway reported', async () => {
    await syncRoutineNotification(complexJob);

    expect(mockSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { type: 'date', date: Date.parse(complexJob.nextRunAt) },
      }),
    );
  });

  test('the one-shot fixture survives a clock moved past the fire it names', async () => {
    // The machine clock is moved three hours on from the instant a wall-clock
    // fixture would carry. A fixture pinned to a real calendar date fails
    // here — a fire that is not still ahead of now is refused — so this case
    // is what stops the suite expiring mid-sprint.
    jest.useFakeTimers({ now: Date.parse('2026-09-10T12:00:00.000Z') });
    try {
      await syncRoutineNotification(complexJob);

      expect(mockSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: { type: 'date', date: Date.parse(complexJob.nextRunAt) },
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('an unmappable cron with no next fire schedules nothing rather than guessing', async () => {
    await syncRoutineNotification({ id: 'job-3', schedule: '*/5 * * * *' });

    expect(mockSchedule).not.toHaveBeenCalled();
    await expect(storedIdFor('job-3')).resolves.toBeNull();
  });

  test('a re-sync that cannot name the next fire keeps the notice already held', async () => {
    // An earlier read priced this job; its notice is waiting on the phone.
    await syncRoutineNotification(dailyJob);
    mockSchedule.mockClear();
    mockCancel.mockClear();

    // The fresh read prices nothing: the cadence is beyond the two repeating
    // shapes and it names no next fire. Absent data is UNKNOWN, not an
    // instruction to retire — the operator's held notice survives.
    await syncRoutineNotification({
      id: 'job-1',
      name: '[bot:scout] Morning briefing',
      schedule: '*/5 * * * *',
    });

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(storedIdFor('job-1')).resolves.toBe('notif-1');
  });

  test('a fire already behind us keeps the held notice until the gateway names a fresh one', async () => {
    await syncRoutineNotification(dailyJob);
    mockSchedule.mockClear();
    mockCancel.mockClear();

    // A fire in the past cannot price a one-shot — the same landing as no
    // fire at all, and the held notice is not retired for it either.
    await syncRoutineNotification({
      id: 'job-1',
      name: '[bot:scout] Morning briefing',
      schedule: '*/5 * * * *',
      nextRunAt: '2001-01-01T09:00:00.000Z',
    });

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(storedIdFor('job-1')).resolves.toBe('notif-1');
  });

  test('a pause still retires the held notice when the row prices no fire', async () => {
    await syncRoutineNotification(dailyJob);
    mockSchedule.mockClear();
    mockCancel.mockClear();

    // A pause is a decision, not missing data: it retires the notice even
    // when the row cannot name a schedulable fire.
    await syncRoutineNotification({
      id: 'job-1',
      name: '[bot:scout] Morning briefing',
      schedule: '*/5 * * * *',
      paused: true,
    });

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith('notif-1');
    await expect(storedIdFor('job-1')).resolves.toBeNull();
  });

  test('an edit that produces a trigger still replaces the held notice exactly once', async () => {
    mockSchedule.mockResolvedValueOnce('notif-1').mockResolvedValueOnce('notif-2');

    // Hold a one-shot first — a cadence only the gateway's next fire prices.
    // A job id no earlier case has mapped, so the counts below are this case's.
    await syncRoutineNotification({
      id: 'job-4',
      name: '[bot:scout] Minute sweep',
      schedule: '*/5 * * * *',
      nextRunAt: '2999-01-01T09:00:00.000Z',
    });

    // The edit names a mappable cadence: the held one-shot goes and exactly
    // one notice takes its place.
    await syncRoutineNotification({ ...dailyJob, id: 'job-4' });

    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith('notif-1');
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    expect(mockSchedule.mock.calls[1][0].trigger).toEqual({ type: 'daily', hour: 9, minute: 0 });
    await expect(storedIdFor('job-4')).resolves.toBe('notif-2');
  });

  test('a scheduling failure persists no identifier behind a phantom id', async () => {
    mockSchedule.mockRejectedValue(new Error('scheduler unavailable'));

    await expect(syncRoutineNotification(dailyJob)).resolves.toBeUndefined();
    await expect(storedIdFor('job-1')).resolves.toBeNull();
  });

  test('a thrown schedule leaves the held notice in place', async () => {
    await keyValueStorage.setItem('versutus:routine-notification:job-5', 'notif-held');
    mockSchedule.mockRejectedValue(new Error('scheduler unavailable'));
    mockCancel.mockClear();

    // The replacement never landed, so the retirement has nothing to act on:
    // a scheduler that throws must not cost the operator the notice they hold.
    await expect(syncRoutineNotification({ ...dailyJob, id: 'job-5' })).resolves.toBeUndefined();

    expect(mockCancel).not.toHaveBeenCalled();
    await expect(storedIdFor('job-5')).resolves.toBe('notif-held');
  });

  test('a landed replacement retires the held notice only after it landed', async () => {
    await keyValueStorage.setItem('versutus:routine-notification:job-6', 'notif-held');
    mockSchedule.mockResolvedValue('notif-new');
    mockCancel.mockClear();

    await syncRoutineNotification({ ...dailyJob, id: 'job-6' });

    // Exactly one notice survives: the held identifier is cancelled and the
    // mapping holds only the live id — and the cancel comes AFTER the schedule
    // that priced it, which is the ordering the held notice's survival rests on.
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith('notif-held');
    expect(mockCancel).not.toHaveBeenCalledWith('notif-new');
    expect(mockSchedule.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancel.mock.invocationCallOrder[0],
    );
    await expect(storedIdFor('job-6')).resolves.toBe('notif-new');
  });
});

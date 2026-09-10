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

const complexJob = {
  id: 'job-2',
  name: '[bot:scout] Minute sweep',
  schedule: '*/5 * * * *',
  nextRunAt: '2026-09-10T09:00:00.000Z',
};

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
});

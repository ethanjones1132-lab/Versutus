import { rearmRoutineNotifications } from '@/lib/notifications/routine-sync';

jest.mock('expo-notifications', () => {
  const queue = new Map<string, { identifier: string; content: { data: unknown } }>();
  let nextId = 0;
  return {
    SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' },
    scheduleNotificationAsync: jest.fn(async (request: { content: { data: unknown } }) => {
      const identifier = `rearm-notice-${++nextId}`;
      queue.set(identifier, { identifier, content: request.content });
      return identifier;
    }),
    cancelScheduledNotificationAsync: jest.fn(async (identifier: string) => {
      queue.delete(identifier);
    }),
    getAllScheduledNotificationsAsync: jest.fn(async () => [...queue.values()]),
    getPermissionsAsync: jest.fn(async () => ({ granted: true })),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
    __clearQueue: () => queue.clear(),
  };
});

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
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

const regular = (id: string, paused = false) => ({
  id,
  name: '[bot:scout] Morning briefing',
  schedule: '0 9 * * *',
  paused,
});
const clearQueue = (jest.requireMock('expo-notifications') as { __clearQueue: () => void }).__clearQueue;

const queuedJobIds = async () =>
  (await Notifications.getAllScheduledNotificationsAsync()).map((notice) => notice.content.data?.jobId);

describe('authoritative routine notice re-arm', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    clearQueue();
  });

  test('cancels a previously scheduled notice when its job is paused', async () => {
    await rearmRoutineNotifications([regular('paused-job')], 'paused-scope');
    await rearmRoutineNotifications([regular('paused-job', true)], 'paused-scope');

    expect(await queuedJobIds()).not.toContain('paused-job');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalled();
  });

  test('cancels a previously scheduled notice when its job is removed', async () => {
    await rearmRoutineNotifications([regular('removed-job')], 'removed-scope');
    await rearmRoutineNotifications([], 'removed-scope');

    expect(await queuedJobIds()).not.toContain('removed-job');
  });

  test('keeps an active job scheduled through re-arm', async () => {
    await rearmRoutineNotifications([regular('active-job')], 'active-scope');
    await rearmRoutineNotifications([regular('active-job')], 'active-scope');

    expect(await queuedJobIds()).toContain('active-job');
  });

  test('a partial read retires no job it failed to name', async () => {
    await rearmRoutineNotifications([regular('kept-job'), regular('missing-job')], 'partial-scope');
    await rearmRoutineNotifications([regular('kept-job')], 'partial-scope', false);

    // Re-arming kept-job may replace its own notice; missing-job's must survive.
    expect(await queuedJobIds()).toEqual(expect.arrayContaining(['kept-job', 'missing-job']));
  });

  test('a partial read still schedules the active jobs it names', async () => {
    await rearmRoutineNotifications([regular('fresh-job')], 'partial-new-scope', false);

    expect(await queuedJobIds()).toContain('fresh-job');
  });

  test('does not cancel notices owned by another gateway scope', async () => {
    await rearmRoutineNotifications([regular('other-gateway-job')], 'gateway-two');
    await rearmRoutineNotifications([], 'gateway-one');

    expect(await queuedJobIds()).toContain('other-gateway-job');
  });
});

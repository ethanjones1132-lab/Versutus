import { rearmRoutineNotifications } from '@/lib/notifications/routine-sync';
import { routineReadScope } from '@/lib/notifications/routine-scope';

jest.mock('expo-notifications', () => {
  const queue = new Map<string, { identifier: string; content: { data: unknown } }>();
  let nextId = 0;
  return {
    SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' },
    scheduleNotificationAsync: jest.fn(async (request: { content: { data: unknown } }) => {
      const identifier = `notice-${++nextId}`;
      queue.set(identifier, { identifier, content: request.content });
      return identifier;
    }),
    cancelScheduledNotificationAsync: jest.fn(async (identifier: string) => {
      queue.delete(identifier);
    }),
    getAllScheduledNotificationsAsync: jest.fn(async () => [...queue.values()]),
    getPermissionsAsync: jest.fn(async () => ({ granted: true })),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { keyValueStorage } from '@/lib/storage/key-value';

const job = (id: string, paused = false) => ({
  id,
  name: '[bot:scout] Morning briefing',
  schedule: '0 9 * * *',
  paused,
});

describe('retiring notices from authoritative routine reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('cancels paused and disappeared jobs only in the named scope', async () => {
    await rearmRoutineNotifications([job('A'), job('B')], 'scope-X');
    await rearmRoutineNotifications([job('C')], 'scope-Y');
    const a = await keyValueStorage.getItem('versutus:routine-notification:A');
    const b = await keyValueStorage.getItem('versutus:routine-notification:B');
    const c = await keyValueStorage.getItem('versutus:routine-notification:C');

    await rearmRoutineNotifications([job('A', true)], 'scope-X');

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(a);
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(b);
    expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalledWith(c);
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    expect(scheduled.map((notice) => notice.content.data)).toContainEqual({
      kind: 'routine-due',
      jobId: 'C',
      botId: 'scout',
    });
    expect(scheduled).toHaveLength(1);
  });

  test('a failed scope-storage read still resolves without sweeping unknown jobs', async () => {
    const storageGet = AsyncStorage.getItem as jest.Mock;
    storageGet.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(rearmRoutineNotifications([], 'scope-X')).resolves.toBeUndefined();
    expect(storageGet).toHaveBeenCalledWith('versutus:routine-notification-scope:scope-X');
  });

  test('a corrupt remembered list is replaced, so later disappearances still retire', async () => {
    await keyValueStorage.setItem('versutus:routine-notification-scope:scope-Z', '{not json');
    await rearmRoutineNotifications([job('D')], 'scope-Z');
    const d = await keyValueStorage.getItem('versutus:routine-notification:D');
    await rearmRoutineNotifications([], 'scope-Z');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(d);
  });
});

describe('routineReadScope', () => {
  test('two Bots of one gateway are different scopes, so a Bot switch retires nothing of the other', () => {
    expect(routineReadScope('gw1', { botId: 'scout' })).not.toBe(routineReadScope('gw1', { botId: 'writer' }));
    expect(routineReadScope('gw1', { botId: 'scout' })).not.toBe(routineReadScope('gw1', {}));
  });

  test('a Bot read is the same scope from the provider and a Bot Chat, whatever environment is pinned', () => {
    expect(routineReadScope('gw1', { botId: 'scout', backendId: 'hermes-local' })).toBe(
      routineReadScope('gw1', { botId: 'scout' }),
    );
  });

  test('environments and gateways are separate scopes', () => {
    expect(routineReadScope('gw1', { backendId: 'a' })).not.toBe(routineReadScope('gw1', { backendId: 'b' }));
    expect(routineReadScope('gw1', {})).not.toBe(routineReadScope('gw2', {}));
  });
});

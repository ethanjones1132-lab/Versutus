import { AppState } from 'react-native';

import {
  dismissGatewayDown,
  notifyGatewayDown,
} from '@/lib/notifications/local';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(),
  dismissNotificationAsync: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

import * as Notifications from 'expo-notifications';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;
const mockDismiss = Notifications.dismissNotificationAsync as jest.Mock;
const mockPresented = Notifications.getPresentedNotificationsAsync as jest.Mock;

// present() refuses to post while the app is foregrounded; the tests below
// pin AppState away from 'active' through a redefinable property so the
// schedule path runs, and flip it back for the suppression case.
const originalStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

function setAppState(value: string): void {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
}

function presentedNotification(identifier: string, title: string): Notifications.Notification {
  return {
    date: 0,
    request: {
      identifier,
      content: {
        title,
        subtitle: null,
        body: null,
        categoryIdentifier: null,
        sound: null,
      },
      trigger: null,
    },
  };
}

describe('gateway-down notification lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    mockDismiss.mockResolvedValue(undefined);
    mockPresented.mockResolvedValue([]);
    // Grant the permission flow so present() reaches scheduleNotificationAsync.
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    mockSchedule.mockResolvedValue('notif-1');
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('notifyGatewayDown schedules the notice under its stable title', async () => {
    await notifyGatewayDown('ethanspc');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.title).toBe('Gateway unreachable');
    expect(request.content.body).toContain('ethanspc');
    expect(request.trigger).toBeNull();
  });

  test('dismissGatewayDown retires the notice this process posted', async () => {
    mockSchedule.mockResolvedValue('notif-7');
    await notifyGatewayDown('ethanspc');

    await dismissGatewayDown();

    expect(mockDismiss).toHaveBeenCalledWith('notif-7');
  });

  test('a notice that outlived the app restart is swept from the tray by title', async () => {
    // No notify first: fresh process holds no identifier, so dismissal can
    // only find the stale entry via getPresentedNotificationsAsync.
    mockPresented.mockResolvedValue([
      presentedNotification('stale-down', 'Gateway unreachable'),
      presentedNotification('keep-me', 'Approval required'),
      presentedNotification('also-stale', 'Gateway unreachable'),
    ]);

    await dismissGatewayDown();

    const dismissedIds = mockDismiss.mock.calls.map((call) => call[0]);
    expect(dismissedIds).toContain('stale-down');
    expect(dismissedIds).toContain('also-stale');
    expect(dismissedIds).not.toContain('keep-me');
  });

  test('recovery dismisses the posted notice even when the tray sweep finds nothing', async () => {
    await notifyGatewayDown('ethanspc');
    mockPresented.mockResolvedValue([]);

    await dismissGatewayDown();

    expect(mockDismiss).toHaveBeenCalledWith('notif-1');
    expect(mockPresented).toHaveBeenCalled();
  });

  test('a skipped notice keeps no identifier, so recovery falls back to the sweep', async () => {
    // Foregrounded posts are suppressed by design — nothing lands in the tray
    // and no identifier is recorded behind a phantom id.
    setAppState('active');
    await notifyGatewayDown('ethanspc');
    expect(mockSchedule).not.toHaveBeenCalled();

    mockPresented.mockResolvedValue([presentedNotification('old', 'Gateway unreachable')]);
    await dismissGatewayDown();
    expect(mockDismiss).not.toHaveBeenCalledWith('notif-1');
    expect(mockDismiss).toHaveBeenCalledWith('old');
  });

  test('dismissal failures never propagate — recovery cleanup is best-effort', async () => {
    await notifyGatewayDown('ethanspc');
    mockDismiss.mockRejectedValue(new Error('tray unavailable'));

    await expect(dismissGatewayDown()).resolves.toBeUndefined();
  });
});

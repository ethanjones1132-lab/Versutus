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

function presentedNotification(
  identifier: string,
  title: string,
  data?: Record<string, unknown>,
): Notifications.Notification {
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
        ...(data ? { data } : {}),
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

  test('notifyGatewayDown schedules the notice under its stable title and payload', async () => {
    await notifyGatewayDown('gw-a', 'ethanspc');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.title).toBe('Gateway unreachable');
    expect(request.content.body).toContain('ethanspc');
    // The gateway key rides in the payload so a restarted process can still
    // attribute the notice to exactly the gateway that posted it.
    expect(request.content.data).toEqual({ kind: 'gateway-down', gatewayKey: 'gw-a' });
    expect(request.trigger).toBeNull();
  });

  test('dismissGatewayDown retires the notice this process posted', async () => {
    mockSchedule.mockResolvedValue('notif-7');
    await notifyGatewayDown('gw-a', 'ethanspc');

    await dismissGatewayDown('gw-a');

    expect(mockDismiss).toHaveBeenCalledWith('notif-7');
  });

  test('dismissal is scoped: another gateway\'s posted notice survives', async () => {
    mockSchedule.mockResolvedValueOnce('notif-a').mockResolvedValueOnce('notif-b');
    await notifyGatewayDown('gw-a', 'alpha');
    await notifyGatewayDown('gw-b', 'bravo');

    await dismissGatewayDown('gw-a');

    expect(mockDismiss).toHaveBeenCalledWith('notif-a');
    expect(mockDismiss).not.toHaveBeenCalledWith('notif-b');

    // The sibling's notice is still attributable: when that gateway answers,
    // its own dismissal retires it.
    await dismissGatewayDown('gw-b');
    expect(mockDismiss).toHaveBeenCalledWith('notif-b');
  });

  test('a notice that outlived the app restart is swept from the tray by payload', async () => {
    // No notify first: fresh process holds no identifier, so dismissal can
    // only find the stale entry via getPresentedNotificationsAsync.
    mockPresented.mockResolvedValue([
      presentedNotification('stale-down-a', 'Gateway unreachable', {
        kind: 'gateway-down',
        gatewayKey: 'gw-a',
      }),
      presentedNotification('stale-down-b', 'Gateway unreachable', {
        kind: 'gateway-down',
        gatewayKey: 'gw-b',
      }),
      presentedNotification('keep-me', 'Approval required'),
    ]);

    await dismissGatewayDown('gw-a');

    const dismissedIds = mockDismiss.mock.calls.map((call) => call[0]);
    expect(dismissedIds).toContain('stale-down-a');
    // gw-b is still down: its notice must not be retired by gw-a answering.
    expect(dismissedIds).not.toContain('stale-down-b');
    expect(dismissedIds).not.toContain('keep-me');
  });

  test('a legacy title-only notice is retired when any gateway answers', async () => {
    // Notices posted before the payload existed carry only the title and
    // cannot be attributed; retiring the stale entry beats leaving it in the
    // tray, and modern payload-scoped notices are unaffected by this path.
    mockPresented.mockResolvedValue([presentedNotification('legacy-down', 'Gateway unreachable')]);

    await dismissGatewayDown('gw-b');

    expect(mockDismiss).toHaveBeenCalledWith('legacy-down');
  });

  test('recovery dismisses the posted notice even when the tray sweep finds nothing', async () => {
    await notifyGatewayDown('gw-a', 'ethanspc');
    mockPresented.mockResolvedValue([]);

    await dismissGatewayDown('gw-a');

    expect(mockDismiss).toHaveBeenCalledWith('notif-1');
    expect(mockPresented).toHaveBeenCalled();
  });

  test('a skipped notice keeps no identifier, so recovery falls back to the sweep', async () => {
    // Foregrounded posts are suppressed by design — nothing lands in the tray
    // and no identifier is recorded behind a phantom id.
    setAppState('active');
    await notifyGatewayDown('gw-a', 'ethanspc');
    expect(mockSchedule).not.toHaveBeenCalled();

    mockPresented.mockResolvedValue([presentedNotification('old', 'Gateway unreachable')]);
    await dismissGatewayDown('gw-a');
    expect(mockDismiss).not.toHaveBeenCalledWith('notif-1');
    expect(mockDismiss).toHaveBeenCalledWith('old');
  });

  test('dismissal failures never propagate — recovery cleanup is best-effort', async () => {
    await notifyGatewayDown('gw-a', 'ethanspc');
    mockDismiss.mockRejectedValue(new Error('tray unavailable'));

    await expect(dismissGatewayDown('gw-a')).resolves.toBeUndefined();
  });
});
import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useNotificationPreferences } from '@/hooks/use-notification-preferences';
import { routeForTap } from '@/lib/notifications/tap-route';
import {
  openReplyTap,
  replyTapDestination,
  replyTapFromLaunch,
  type ReplyTap,
} from '@/lib/notifications/launch-response';

const mockGatewayRequest = jest.fn();
const mockSyncPushRegistration = jest.fn();
let mockActiveGateway = { id: 'gateway-b', kind: 'custom' };

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    activeGateway: mockActiveGateway,
    status: 'connected',
    gatewayRequest: mockGatewayRequest,
  }),
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  requestPermissionsAsync: jest.fn(),
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn().mockResolvedValue({ deviceId: 'device-test' }),
  syncPushRegistration: (...args: unknown[]) => mockSyncPushRegistration(...args),
}));

let preferences: ReturnType<typeof useNotificationPreferences>;
function PreferencesHarness() {
  const current = useNotificationPreferences();
  useEffect(() => {
    preferences = current;
  });
  return null;
}

function response(data: unknown): Parameters<typeof replyTapFromLaunch>[0] {
  return {
    notification: {
      date: 0,
      request: {
        identifier: 'reply-tap',
        content: {
          title: '', subtitle: null, body: '', categoryIdentifier: null,
          sound: null, data: data as Record<string, unknown>,
        },
        trigger: null,
      },
    },
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
  };
}

describe('reply taps preserve their gateway', () => {
  const payload = { kind: 'reply', sessionId: 'shared-session', botId: 'scout', gatewayKey: 'gateway-b' };

  test('routeForTap keeps the profile key and old payloads keep their old shape', () => {
    expect(routeForTap(payload)).toEqual({
      kind: 'reply', sessionId: 'shared-session', botId: 'scout', gatewayKey: 'gateway-b',
    });
    expect(routeForTap({ kind: 'reply', sessionId: 'shared-session', botId: 'scout' })).toEqual({
      kind: 'reply', sessionId: 'shared-session', botId: 'scout',
    });
  });

  test.each(['warm listener', 'cold launch response'])('%s selects B before opening the shared session', async (entry) => {
    let activeGatewayKey = 'gateway-a';
    const order: string[] = [];
    const reply = entry === 'cold launch response'
      ? replyTapFromLaunch(response(payload))!
      : routeForTap(payload) as ReplyTap;
    const result = await openReplyTap(reply, {
      activeGatewayKey,
      gatewayKeys: ['gateway-a', 'gateway-b'],
      selectGateway: async (gatewayKey) => {
        order.push(`select:${gatewayKey}`);
        activeGatewayKey = gatewayKey;
      },
      waitForActiveGateway: async (gatewayKey) => {
        expect(activeGatewayKey).toBe(gatewayKey);
        order.push(`active:${gatewayKey}`);
      },
      openSession: (sessionId) => order.push(`open:${activeGatewayKey}:${sessionId}`),
    });
    expect(result).toBe('opened');
    expect(order).toEqual([
      'select:gateway-b', 'active:gateway-b', 'open:gateway-b:shared-session',
    ]);
  });

  test('a deleted profile falls back without opening the session', async () => {
    const openSession = jest.fn();
    const result = await openReplyTap(routeForTap(payload) as ReplyTap, {
      activeGatewayKey: 'gateway-a',
      gatewayKeys: ['gateway-a'],
      selectGateway: jest.fn(),
      waitForActiveGateway: jest.fn(),
      openSession,
    });
    expect(result).toBe('unknown-gateway');
    expect(replyTapDestination(result)).toBe('/activity');
    expect(openSession).not.toHaveBeenCalled();
  });
});

describe('notification preference registration is scoped to its gateway profile', () => {
  let renderer: ReactTestRenderer;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockActiveGateway = { id: 'gateway-b', kind: 'custom' };
    mockGatewayRequest.mockImplementation((method: string) => Promise.resolve(
      method === 'notifications.preferences.get' ? { enabled: false } : { enabled: true },
    ));
    await act(async () => {
      renderer = create(createElement(PreferencesHarness));
    });
  });

  afterEach(async () => {
    await act(async () => renderer.unmount());
  });

  test('enabling notifications registers the active profile key', async () => {
    await act(async () => {
      await preferences.setEnabled(true);
    });
    // The registration is fired from the enable's own follow-up; under a loaded
    // full run it can land a few ticks later, so let it settle before asserting.
    for (let i = 0; i < 10 && mockSyncPushRegistration.mock.calls.length === 0; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(mockSyncPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ rpcRequest: expect.any(Function) }),
      'gateway-b',
    );
  });
});

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useNotificationPreferences } from '@/hooks/use-notification-preferences';

const mockRequest = jest.fn();
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    activeGateway: { kind: 'custom' },
    status: 'connected',
    gatewayRequest: mockRequest,
  }),
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn().mockResolvedValue({ deviceId: 'test-device' }),
  syncPushRegistration: jest.fn(),
}));

let preferences: ReturnType<typeof useNotificationPreferences>;
function Harness() {
  preferences = useNotificationPreferences();
  return null;
}

let renderer: ReactTestRenderer;
beforeEach(async () => {
  jest.useFakeTimers();
  mockRequest.mockReset().mockResolvedValue({});
  await act(async () => { renderer = create(createElement(Harness)); });
});
afterEach(async () => {
  await act(async () => { renderer.unmount(); });
  jest.useRealTimers();
});

test.each([{ ok: false }, { ok: false, error: {} }, { ok: false, error: 'Expo unavailable' }, {}, null])(
  'a failed Expo send reports failure, not success: %j',
  async (result) => {
    mockRequest.mockResolvedValue(result);
    await act(async () => { await preferences.sendTest(); });
    expect(preferences.error).toBe('The Gate could not send the test through Expo — try again.');
    expect(preferences.testResult).toBeNull();
    expect(preferences.sendingTest).toBe(false);
  },
);

test('a successful test keeps the background-or-killed guidance and names the device', async () => {
  mockRequest.mockResolvedValue({ ok: true });
  await act(async () => { await preferences.sendTest(); });
  expect(mockRequest).toHaveBeenCalledWith('notifications.test', { deviceId: 'test-device' });
  expect(preferences.testResult).toBe('Test sent — it should arrive with the app backgrounded or killed.');
  expect(preferences.error).toBeNull();
});

test('a device without a token keeps the reconnect guidance', async () => {
  mockRequest.mockResolvedValue({ skipped: 'no-token' });
  await act(async () => { await preferences.sendTest(); });
  expect(preferences.testResult).toBe('The Gate has no token for this device yet — reconnect, then try again.');
  expect(preferences.error).toBeNull();
});

test('an identity failure is shown instead of a paired-device grant refusal', async () => {
  const { DeviceIdentityError } = jest.requireActual('@/lib/gateway/errors') as {
    DeviceIdentityError: new () => Error;
  };
  const push = jest.requireMock('@/lib/notifications/push-registration') as {
    pushDeviceParams: jest.Mock;
  };
  mockRequest.mockClear();
  push.pushDeviceParams.mockRejectedValueOnce(new DeviceIdentityError());
  await act(async () => {
    await preferences.reload();
  });
  expect(preferences.error).toMatch(/device identity/i);
  expect(preferences.error).not.toMatch(/paired device grant/i);
  expect(mockRequest).not.toHaveBeenCalled();
});

test('a paired-device refusal after the phone named itself reads as pairing, not a missing identity', async () => {
  const { GatewayHttpError } = jest.requireActual('@/lib/gateway/errors') as {
    GatewayHttpError: new (message: string, status: number) => Error;
  };
  mockRequest.mockRejectedValueOnce(new GatewayHttpError('A paired device grant is required', 403));
  await act(async () => {
    await preferences.reload();
  });
  expect(mockRequest).toHaveBeenCalledWith('notifications.preferences.get', { deviceId: 'test-device' });
  expect(preferences.error).toMatch(/paired/i);
  expect(preferences.error).not.toMatch(/could not make its device identity/i);
});

test('a failed retry clears an earlier successful result', async () => {
  mockRequest.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
  await act(async () => { await preferences.sendTest(); });
  await act(async () => { await preferences.sendTest(); });
  expect(preferences.testResult).toBeNull();
  expect(preferences.error).toBe('The Gate could not send the test through Expo — try again.');
});

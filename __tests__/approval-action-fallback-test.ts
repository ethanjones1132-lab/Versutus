import { AppState } from 'react-native';

import {
  decisionCanReachGateway,
  isApprovalActionFor,
} from '@/lib/notifications/approval-action';
import { APPROVAL_NOTICE_DATA_KIND } from '@/lib/notifications/categories';
import { notifyApprovalUnreachable } from '@/lib/notifications/local';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

import * as Notifications from 'expo-notifications';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The response listener body — where a decision is applied or refused. */
const listener = () =>
  between(
    between(
      readSource('src', 'app', '_layout.tsx'),
      'function NotificationRouter',
      'function GatewayDeepLinkRouter',
    ),
    'addNotificationResponseReceivedListener',
    'return () => subscription.remove()',
  );

// present() refuses to post while the app is foregrounded, and a decision
// arrives with the app backgrounded by design (`opensAppToForeground: false`),
// so the notice tests below pin AppState away from 'active'.
const originalStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

function setAppState(value: string): void {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
}

const grantedPermissions = { granted: true, status: 'granted' };

describe('decisionCanReachGateway (the fail-closed gate)', () => {
  test('a live connection is the only one that carries a decision', () => {
    expect(decisionCanReachGateway('connected')).toBe(true);
  });

  test('every other status refuses', () => {
    // resolveRunApproval settles the LOCAL driver's own promise and the driver
    // then reports the decision to the gateway, so a decision taken while the
    // connection is gone would never reach the run.
    expect(decisionCanReachGateway('disconnected')).toBe(false);
    expect(decisionCanReachGateway('connecting')).toBe(false);
    expect(decisionCanReachGateway('reconnecting')).toBe(false);
    expect(decisionCanReachGateway('pairing')).toBe(false);
  });
});

describe('the refusal premise: payloads the guard will not match', () => {
  const payload = (runId: unknown) => ({
    kind: APPROVAL_NOTICE_DATA_KIND,
    runId,
    gatewayKey: 'gw-a',
  });

  test('a payload naming no run, or another run, is not the pending approval', () => {
    expect(isApprovalActionFor(payload(''), 'run-7')).toBe(false);
    expect(isApprovalActionFor({ kind: APPROVAL_NOTICE_DATA_KIND }, 'run-7')).toBe(false);
    expect(isApprovalActionFor(payload('run-8'), 'run-7')).toBe(false);
  });

  test('no pending approval to match against refuses', () => {
    expect(isApprovalActionFor(payload('run-7'), '')).toBe(false);
  });
});

describe('notifyApprovalUnreachable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue(grantedPermissions);
    mockSchedule.mockResolvedValue('notif-1');
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('the fallback is an immediate notice saying the decision did not reach the gateway', async () => {
    await notifyApprovalUnreachable();

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.title).toBe('Approval not sent');
    // Honest copy: the decision never reached the gateway and the operator is
    // pointed at the app, where the approval is still waiting. No count, no
    // claim that anything was decided.
    expect(request.content.body).toContain("Couldn't reach the gateway");
    expect(request.content.body).toContain('open Versutus');
    expect(request.trigger).toBeNull();
  });

  test('the fallback wears no category, so it offers no second set of buttons', async () => {
    await notifyApprovalUnreachable();

    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.categoryIdentifier).toBeUndefined();
  });

  test('a foregrounded fallback is suppressed, exactly as the other notices are', async () => {
    setAppState('active');

    await notifyApprovalUnreachable();

    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('NotificationRouter fail-closed wiring', () => {
  test('a decision that cannot be applied posts the fallback instead of deciding', () => {
    const src = listener();

    // Both gates sit ahead of the tap destination: the connection must be live
    // and the payload must name the approval pending right now, so a refused
    // decision neither resolves nor falls through silently.
    const gate = src.indexOf('decisionCanReachGateway(statusRef.current)');
    const guard = src.indexOf('isApprovalActionFor(');
    const fallback = src.indexOf('notifyApprovalUnreachable()');
    const destination = src.indexOf('const destination = destinationFor(');
    expect(gate).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(gate);
    expect(fallback).toBeGreaterThan(guard);
    expect(fallback).toBeLessThan(destination);
  });

  test('a refused decision never resolves the pending approval', () => {
    // The approval stays pending for the operator to decide in the app, so the
    // listener holds exactly one resolve call — the one in the applying branch.
    expect((listener().match(/pendingApproval\.resolve\(/g) ?? []).length).toBe(1);
  });

  test('the connection status is read from a ref, so the listener is registered once', () => {
    const src = between(
      readSource('src', 'app', '_layout.tsx'),
      'function NotificationRouter',
      'function GatewayDeepLinkRouter',
    );

    expect(src).toContain('statusRef.current = status');
    const listenerEnd = src.slice(src.indexOf('addNotificationResponseReceivedListener'));
    expect(listenerEnd).toContain('}, [router, isBootstrapped]);');
  });
});

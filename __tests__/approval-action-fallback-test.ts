import { AppState } from 'react-native';

import {
  approvalDecisionCopy,
  approvalRefusalCopy,
  approvalRefusalReason,
  decisionCanReachGateway,
  isApprovalActionFor,
} from '@/lib/notifications/approval-action';
import { APPROVAL_NOTICE_DATA_KIND } from '@/lib/notifications/categories';
import { notifyApprovalDecided, notifyApprovalRefused } from '@/lib/notifications/local';

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

// Restored once, after every describe that pins AppState: a later describe
// setting the same property would otherwise meet the original descriptor.
afterAll(() => {
  if (originalStateDescriptor) {
    Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
  }
});

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

describe('approvalRefusalReason (the refusal table)', () => {
  const payload = (runId: unknown) => ({
    kind: APPROVAL_NOTICE_DATA_KIND,
    runId,
    gatewayKey: 'gw-a',
  });

  test('a decision about the run this app is driving over a live connection is no refusal', () => {
    expect(approvalRefusalReason('connected', payload('run-7'), 'run-7')).toBeNull();
  });

  test('the same decision over a dead connection cannot be sent, and says so', () => {
    // The one case that may blame the gateway: a run this app IS driving is
    // waiting right now, and the decision has nowhere to go.
    expect(approvalRefusalReason('disconnected', payload('run-7'), 'run-7')).toBe('unreachable');
    expect(approvalRefusalReason('connecting', payload('run-7'), 'run-7')).toBe('unreachable');
    expect(approvalRefusalReason('reconnecting', payload('run-7'), 'run-7')).toBe('unreachable');
    expect(approvalRefusalReason('pairing', payload('run-7'), 'run-7')).toBe('unreachable');
  });

  test('a notice with nothing waiting behind it blames nothing, connected or not', () => {
    // The case the table exists for: the run was decided in the app (or by an
    // earlier tap on the same notice), and `resolveRunApproval` nulls the
    // pending approval the instant it is decided — so the second tap has
    // nothing to send. A gateway claim here would be false, whatever the
    // connection is doing: there was never a decision to carry.
    expect(approvalRefusalReason('connected', payload('run-7'), null)).toBe('no-longer-waiting');
    expect(approvalRefusalReason('disconnected', payload('run-7'), null)).toBe('no-longer-waiting');
  });

  test('a payload naming another run is not the approval pending here', () => {
    expect(approvalRefusalReason('connected', payload('run-8'), 'run-7')).toBe('no-longer-waiting');
    expect(approvalRefusalReason('disconnected', payload('run-8'), 'run-7')).toBe('no-longer-waiting');
  });

  test('a half-shaped or foreign payload is no longer waiting, never a gateway claim', () => {
    const notThisApproval = [
      undefined,
      null,
      'approval',
      {},
      { kind: APPROVAL_NOTICE_DATA_KIND },
      { kind: APPROVAL_NOTICE_DATA_KIND, runId: '' },
      { kind: 'run', runId: 'run-7' },
    ];

    for (const data of notThisApproval) {
      expect(approvalRefusalReason('connected', data, 'run-7')).toBe('no-longer-waiting');
      expect(approvalRefusalReason('disconnected', data, 'run-7')).toBe('no-longer-waiting');
    }
  });
});

describe('approvalRefusalCopy (one table, two honest notices)', () => {
  test('the unreachable copy keeps the fail-closed wording it shipped with', () => {
    expect(approvalRefusalCopy('unreachable')).toEqual({
      title: 'Approval not sent',
      body: "Couldn't reach the gateway — open Versutus to decide",
    });
  });

  test('the nothing-pending copy makes no claim about the gateway', () => {
    const copy = approvalRefusalCopy('no-longer-waiting');

    expect(copy.body).toContain('This approval is no longer waiting');
    // No gateway claim, no result count, no pretend decision.
    expect(copy.title).not.toContain('gateway');
    expect(copy.body).not.toContain('gateway');
    expect(copy.body).not.toContain('reach');
  });
});

describe('approvalDecisionCopy (the decision that landed)', () => {
  test('an approval wears the spec copy for a run that continues', () => {
    expect(approvalDecisionCopy('approve')).toEqual({
      title: 'Approved',
      body: 'Approved — run continuing',
    });
  });

  test('a denial states the denial, never the opposite decision', () => {
    const approve = approvalDecisionCopy('approve');
    const deny = approvalDecisionCopy('deny');

    expect(deny.body).toContain('Denied');
    expect(deny.body).not.toContain('Approved');
    expect(deny.title).not.toBe(approve.title);
    expect(deny.body).not.toBe(approve.body);
  });

  test('a landed decision claims no gateway verdict and no count', () => {
    for (const decision of ['approve', 'deny'] as const) {
      const copy = approvalDecisionCopy(decision);
      const spoken = `${copy.title} ${copy.body}`.toLowerCase();

      // The decision was TAKEN here; the driver's own report to the gateway is
      // what carries it, so no copy may say the gateway accepted (or refused)
      // anything — and nothing reports a result count.
      expect(spoken).not.toContain('gateway');
      expect(spoken).not.toContain('accepted');
      expect(spoken).not.toMatch(/\d/);
    }
  });

  test('the decision copy is a table of its own, not a refusal re-used', () => {
    const refusalBodies = [
      approvalRefusalCopy('unreachable').body,
      approvalRefusalCopy('no-longer-waiting').body,
    ];

    for (const decision of ['approve', 'deny'] as const) {
      const copy = approvalDecisionCopy(decision);
      expect(refusalBodies).not.toContain(copy.body);
      expect(copy.body).not.toContain("Couldn't reach the gateway");
    }
  });
});

describe('notifyApprovalDecided', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue(grantedPermissions);
    mockSchedule.mockResolvedValue('notif-1');
  });

  test('a landed approval posts the outcome immediately, on the trigger the other notices use', async () => {
    await notifyApprovalDecided('approve');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.title).toBe('Approved');
    // The copy names the decision and what it asks for, and nothing else: no
    // gateway verdict, no result count.
    expect(request.content.body).toContain('Approved');
    expect(request.content.body).toContain('run continuing');
    expect(request.trigger).toBeNull();
  });

  test('a landed denial posts its own copy, not the approval wording', async () => {
    await notifyApprovalDecided('deny');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.title).toBe(approvalDecisionCopy('deny').title);
    expect(request.content.body).toBe(approvalDecisionCopy('deny').body);
    expect(request.trigger).toBeNull();
  });

  test('the outcome wears no payload and no category: a tap cannot read it as an approval', async () => {
    await notifyApprovalDecided('approve');
    await notifyApprovalDecided('deny');

    for (const call of mockSchedule.mock.calls) {
      // No payload means routeForTap cannot route it and no action can be
      // attached to it; no category means it offers no second set of buttons.
      expect(call[0].content.data).toBeUndefined();
      expect(call[0].content.categoryIdentifier).toBeUndefined();
    }
  });

  test('a foregrounded outcome is suppressed, exactly as the other notices are', async () => {
    setAppState('active');

    await notifyApprovalDecided('approve');
    await notifyApprovalDecided('deny');

    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('notifyApprovalRefused', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue(grantedPermissions);
    mockSchedule.mockResolvedValue('notif-1');
  });

  test('the unreachable refusal is an immediate notice saying the decision did not reach the gateway', async () => {
    await notifyApprovalRefused('unreachable');

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

  test('the nothing-pending refusal is immediate, and says the approval is not waiting', async () => {
    await notifyApprovalRefused('no-longer-waiting');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.title).toBe(approvalRefusalCopy('no-longer-waiting').title);
    expect(request.content.body).toBe(approvalRefusalCopy('no-longer-waiting').body);
    expect(request.trigger).toBeNull();
    // No payload: the refusal is not an approval notice, so a tap on it can
    // never be read back as one (routeForTap).
    expect(request.content.data).toBeUndefined();
  });

  test('a refusal wears no category, so it offers no second set of buttons', async () => {
    await notifyApprovalRefused('unreachable');
    await notifyApprovalRefused('no-longer-waiting');

    for (const call of mockSchedule.mock.calls) {
      expect(call[0].content.categoryIdentifier).toBeUndefined();
    }
  });

  test('a foregrounded refusal is suppressed, exactly as the other notices are', async () => {
    setAppState('active');

    await notifyApprovalRefused('unreachable');
    await notifyApprovalRefused('no-longer-waiting');

    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('NotificationRouter fail-closed wiring', () => {
  test('a decision that cannot be applied posts a refusal instead of deciding', () => {
    const src = listener();

    // All three sit ahead of the tap destination: the connection must be live
    // and the payload must name the approval pending right now, so a refused
    // decision neither resolves nor falls through silently.
    const gate = src.indexOf('decisionCanReachGateway(statusRef.current)');
    const guard = src.indexOf('isApprovalActionFor(');
    const refusal = src.indexOf('notifyApprovalRefused(');
    const destination = src.indexOf('const destination = destinationFor(');
    expect(gate).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(gate);
    expect(refusal).toBeGreaterThan(guard);
    expect(refusal).toBeLessThan(destination);
  });

  test('the refusal copy comes from the table, not from a hard-coded line in the listener', () => {
    const src = listener();

    // The reason is read from the same three inputs the table takes: the live
    // status, the response's payload, and the run this app is driving now.
    expect(src).toContain('approvalRefusalReason(');
    expect(src).toContain('statusRef.current');
    expect(src).toContain('pendingApproval?.runId ?? null');
    expect(src).not.toContain("Couldn't reach the gateway");
  });

  test('a refused decision never resolves the pending approval', () => {
    // The approval stays pending for the operator to decide in the app, so the
    // listener holds exactly one resolve call — the one in the applying branch.
    expect((listener().match(/pendingApproval\.resolve\(/g) ?? []).length).toBe(1);
  });

  test('a landed decision posts its outcome on the same branch that resolves', () => {
    const src = listener();

    // The decision, the resolve it lands through, and the follow-up that names
    // the outcome: the follow-up sits behind the resolve, and the branch then
    // returns — a landed decision leaves the tap path, so the follow-up is not
    // required to sit ahead of the destination fallback.
    const decision = src.indexOf('const decision = approvalDecisionFor(');
    const resolve = src.indexOf('pendingApproval.resolve(decision ===');
    const followUp = src.indexOf('void notifyApprovalDecided(decision)');
    const destination = src.indexOf('const destination = destinationFor(');

    expect(decision).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(decision);
    expect(followUp).toBeGreaterThan(resolve);
    expect(src.slice(followUp, destination)).toContain('return;');
  });

  test('only a landed decision posts the outcome — a plain tap has none to post', () => {
    const src = listener();

    // One call, inside the branch the decision guards; the copy comes from the
    // table, never from a hard-coded line in the listener.
    expect((src.match(/notifyApprovalDecided\(/g) ?? []).length).toBe(1);
    expect(src).not.toContain('Approved — run continuing');
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

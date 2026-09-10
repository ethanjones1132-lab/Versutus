import * as Notifications from 'expo-notifications';

import {
  approvalDecisionFor,
  isApprovalActionFor,
} from '@/lib/notifications/approval-action';
import {
  APPROVAL_APPROVE_ACTION_ID,
  APPROVAL_DENY_ACTION_ID,
  APPROVAL_NOTICE_DATA_KIND,
} from '@/lib/notifications/categories';

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

const layout = () => readSource('src', 'app', '_layout.tsx');

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('approvalDecisionFor (pure action decision)', () => {
  test('the approve button asks to approve, the deny button asks to deny', () => {
    expect(approvalDecisionFor(APPROVAL_APPROVE_ACTION_ID)).toBe('approve');
    expect(approvalDecisionFor(APPROVAL_DENY_ACTION_ID)).toBe('deny');
  });

  test('a plain tap is not a decision', () => {
    // expo's own DEFAULT_ACTION_IDENTIFIER: tapping the notice body delivers
    // the default action, and a tap body must keep going to Activity.
    expect(approvalDecisionFor(Notifications.DEFAULT_ACTION_IDENTIFIER)).toBeNull();
  });

  test('an action this sprint does not know is not a decision', () => {
    expect(approvalDecisionFor('reply')).toBeNull();
    expect(approvalDecisionFor('Approve')).toBeNull();
    expect(approvalDecisionFor('')).toBeNull();
  });
});

describe('isApprovalActionFor (the payload guard)', () => {
  const payload = (runId: unknown) => ({ kind: APPROVAL_NOTICE_DATA_KIND, runId, gatewayKey: 'gw-a' });

  test('the approval notice for the pending run is the one an action may decide', () => {
    expect(isApprovalActionFor(payload('run-7'), 'run-7')).toBe(true);
  });

  test('a payload naming any other run refuses', () => {
    // An approval exists only while THIS app drives the run (CONTEXT.md), so
    // the payload's run id must be the pending one exactly.
    expect(isApprovalActionFor(payload('run-8'), 'run-7')).toBe(false);
  });

  test('a payload that is not an approval notice refuses', () => {
    expect(isApprovalActionFor({ kind: 'run', runId: 'run-7' }, 'run-7')).toBe(false);
    expect(isApprovalActionFor({ kind: 'gateway-down', gatewayKey: 'gw-a' }, 'gw-a')).toBe(false);
    expect(isApprovalActionFor({ runId: 'run-7' }, 'run-7')).toBe(false);
  });

  test('an absent or half-shaped payload refuses, never a half-match', () => {
    expect(isApprovalActionFor(undefined, 'run-7')).toBe(false);
    expect(isApprovalActionFor(null, 'run-7')).toBe(false);
    expect(isApprovalActionFor('approval', 'run-7')).toBe(false);
    expect(isApprovalActionFor({}, 'run-7')).toBe(false);
    expect(isApprovalActionFor({ kind: APPROVAL_NOTICE_DATA_KIND }, 'run-7')).toBe(false);
    expect(isApprovalActionFor({ kind: APPROVAL_NOTICE_DATA_KIND, runId: '' }, '')).toBe(false);
    expect(isApprovalActionFor({ kind: APPROVAL_NOTICE_DATA_KIND, runId: 7 }, '7')).toBe(false);
  });

  test('no pending run to match against refuses', () => {
    expect(isApprovalActionFor(payload('run-7'), '')).toBe(false);
  });
});

describe('NotificationRouter approval actions', () => {
  const routerSource = () =>
    between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');

  test('the action decision is applied ahead of the destination fallback', () => {
    const src = routerSource();
    const listener = between(
      src,
      'addNotificationResponseReceivedListener',
      'return () => subscription.remove()',
    );

    // The decision is not a destination: it is taken before the payload is
    // folded into a route, so an Approve / Deny never also navigates.
    const decision = listener.indexOf('const decision = approvalDecisionFor(response.actionIdentifier)');
    const destination = listener.indexOf('const destination = destinationFor(');
    expect(decision).toBeGreaterThan(-1);
    expect(destination).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(destination);
    expect(listener.indexOf('isApprovalActionFor(')).toBeGreaterThan(-1);
    expect(listener.indexOf('isApprovalActionFor(')).toBeLessThan(destination);
  });

  test('a decision resolves the pending approval through the provider', () => {
    const listener = between(
      routerSource(),
      'addNotificationResponseReceivedListener',
      'return () => subscription.remove()',
    );

    // One resolver, the same one the in-app approval sheet calls.
    expect(listener).toContain("pendingApproval.resolve(decision === 'approve')");
  });

  test('only a live pending approval can be decided', () => {
    const src = routerSource();

    // The listener is registered once, so it reads the pending approval from
    // the ref the provider's state is mirrored into rather than closing over a
    // settled one.
    expect(src).toContain('approvalRef.current = pendingRunApproval');
    expect(src).toContain('pendingApproval &&');
  });

  test('the deep-link router keeps its add / gateway/add handling', () => {
    const src = between(layout(), 'function GatewayDeepLinkRouter', 'export default function RootLayout');
    expect(src).toContain("path !== 'add' && path !== 'gateway/add'");
    expect(src).toContain("pathname: '/gateway/add'");
  });
});

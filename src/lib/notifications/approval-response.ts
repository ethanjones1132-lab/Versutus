// ─── An approval ACTION that survived the restart (FUTURE-ITEMS.md §2) ───
// A live tap on Approve / Deny is handled by the response listener in
// src/app/_layout.tsx. A tap that LAUNCHED the process is not replayed to that
// listener (Expo v57 notifications docs, "Responding to a notification tap"),
// so it reaches the app only as the response `getLastNotificationResponse()`
// returns at boot. That response carries the whole action — `actionIdentifier`
// included — and reading only its destination is what dropped the operator's
// decision: the app opened the run still waiting instead of settling the
// approval the promise was still holding.
//
// This module is the one place those rules live for the launch path, free of
// expo-notifications calls so every branch is jest-pinnable: the action
// identifier is the discriminator (a body tap is not a decision), the payload
// must name the approval pending right now (only runs THIS app initiated can be
// approved — CONTEXT.md, ADR 0001), and the connection must still be live
// (resolveRunApproval settles the local driver's promise, and the driver then
// reports the decision to the gateway). A decision that lands resolves that
// promise — the same one the in-app approval sheet resolves — and posts the
// acknowledgement; anything else is refused with the honest reason and leaves
// the approval pending.
//
// applyLaunchApproval is the launch path's entry: it answers whether the
// response DECIDED the approval or still needs its destination routed, so a
// landed decision never also navigates to the run it just settled.

import type * as Notifications from 'expo-notifications';

import type { ConnectionStatus } from '@/lib/gateway/types';

import {
  approvalDecisionFor,
  approvalRefusalReason,
  decisionCanReachGateway,
  isApprovalActionFor,
  type ApprovalDecision,
  type ApprovalRefusalReason,
} from './approval-action';

/** The approval the app is driving right now, and the sheet's own resolver. */
export type PendingApproval = {
  runId: string;
  resolve: (approved: boolean) => void;
};

/** What an approval action is allowed to touch, injected so this stays pure. */
export interface ApprovalActionDeps {
  pending: PendingApproval | null;
  status: ConnectionStatus;
  notifyDecided: (decision: ApprovalDecision) => void;
  notifyRefused: (reason: ApprovalRefusalReason) => void;
}

/** What applying a response's action did, so the caller knows whether to route. */
export type ApprovalActionResult =
  | { kind: 'decided'; decision: ApprovalDecision }
  | { kind: 'refused'; reason: ApprovalRefusalReason }
  | { kind: 'not-an-approval' };

/**
 * Apply the action a response carries, with the same rules the live listener
 * applies. A plain tap (expo's DEFAULT_ACTION_IDENTIFIER) is not an approval
 * action and changes nothing. A decision about the pending run over a live
 * connection resolves the pending approval and posts its acknowledgement; any
 * other action is refused with the reason the table names, and the approval
 * stays pending.
 */
export function applyApprovalAction(
  response: Notifications.NotificationResponse,
  deps: ApprovalActionDeps,
): ApprovalActionResult {
  const decision = approvalDecisionFor(response.actionIdentifier);
  if (!decision) return { kind: 'not-an-approval' };

  const data = response.notification.request.content.data;
  const pending = deps.pending;

  if (
    pending &&
    decisionCanReachGateway(deps.status) &&
    isApprovalActionFor(data, pending.runId)
  ) {
    pending.resolve(decision === 'approve');
    deps.notifyDecided(decision);
    return { kind: 'decided', decision };
  }

  const reason = approvalRefusalReason(deps.status, data, pending?.runId ?? null);
  if (!reason) return { kind: 'not-an-approval' };
  deps.notifyRefused(reason);
  return { kind: 'refused', reason };
}

/** Whether the launch tap settled its approval, or still needs its destination. */
export type LaunchApprovalOutcome = 'decided' | 'route';

/**
 * The launch path's one call. A cold-start response carries the same decision a
 * live listener would apply, so it is offered the same deps — and when it lands,
 * 'decided' tells the caller to stop there rather than open the run it settled.
 * A refusal still routes: the approval is kept pending on purpose, and the run
 * it names is exactly where the operator can decide it in the app.
 */
export function applyLaunchApproval(
  response: Notifications.NotificationResponse,
  deps: ApprovalActionDeps,
): LaunchApprovalOutcome {
  return applyApprovalAction(response, deps).kind === 'decided' ? 'decided' : 'route';
}

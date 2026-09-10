// ─── Pure decision helper for an approval notice's buttons (FUTURE-ITEMS.md §2) ──
// Free of expo-notifications calls, so every rule here is jest-pinnable without
// mocks: the imports are the approval marker and the two action identifiers
// from categories.ts, plus the connection status type. The response listener in
// src/app/_layout.tsx reads the response's actionIdentifier, payload and the
// live status, and applies this decision ahead of the tap's destination.
//
// An approval is decided from the banner, without opening the app
// (`opensAppToForeground: false` on both actions, registered in categories.ts).
// The action identifier is the discriminator — a plain tap delivers expo's
// DEFAULT_ACTION_IDENTIFIER, which is not a decision — the payload must name the
// approval pending right now, because only runs THIS app initiated can be
// approved (CONTEXT.md, ADR 0001), and the connection must still be live.
// Anything else refuses here and keeps the tap's existing Activity destination;
// the caller posts an honest notice rather than pretending to have decided, and
// `approvalRefusalReason` / `approvalRefusalCopy` below decide WHICH notice —
// "nothing is waiting" and "the connection is gone" are different truths.

import type { ConnectionStatus } from '@/lib/gateway/types';

import {
  APPROVAL_APPROVE_ACTION_ID,
  APPROVAL_DENY_ACTION_ID,
  APPROVAL_NOTICE_DATA_KIND,
} from './categories';

/** What an approval action asks for; the caller turns this into a boolean. */
export type ApprovalDecision = 'approve' | 'deny';

/**
 * The decision an action identifier asks for, or null when it asks for none —
 * a plain tap on the notice body (expo's DEFAULT_ACTION_IDENTIFIER), or an
 * action this sprint does not know. Null means "not an approval decision", so
 * the caller keeps its normal tap routing.
 */
export function approvalDecisionFor(actionIdentifier: string): ApprovalDecision | null {
  if (actionIdentifier === APPROVAL_APPROVE_ACTION_ID) return 'approve';
  if (actionIdentifier === APPROVAL_DENY_ACTION_ID) return 'deny';
  return null;
}

/**
 * Whether a payload is the approval notice for exactly the run that is pending
 * now. The run id must be present and equal: a notice for a run that already
 * settled, for another gateway's run, or a half-shaped payload is never a
 * match — an action must not decide a run this app is not driving.
 */
export function isApprovalActionFor(data: unknown, runId: string): boolean {
  if (!data || typeof data !== 'object' || runId.length === 0) return false;
  const payload = data as Record<string, unknown>;
  if (payload.kind !== APPROVAL_NOTICE_DATA_KIND) return false;
  return typeof payload.runId === 'string' && payload.runId.length > 0 && payload.runId === runId;
}

/**
 * Whether the connection can still carry a decision to its run.
 *
 * `resolveRunApproval` settles the local driver's own promise, and the driver
 * then reports the decision to the gateway — so a decision taken while the
 * connection is gone never reaches the run, and claiming otherwise would be a
 * lie. Only `connected` may decide; every other status fails closed, leaves the
 * approval pending and has the caller post an honest notice.
 */
export function decisionCanReachGateway(status: ConnectionStatus): boolean {
  return status === 'connected';
}

/** Why an Approve / Deny action could not be applied — and so what it says. */
export type ApprovalRefusalReason = 'unreachable' | 'no-longer-waiting';

/**
 * The reason a decision was refused, or null when nothing is refused: the
 * payload names the approval this app is driving and the connection can carry
 * the decision.
 *
 * The table is ordered by what is true about the ACTION, not about the radio.
 * Only a decision that was about a run this app is driving right now can
 * honestly blame the gateway for not sending it. A notice with nothing waiting
 * behind it — the run was already decided, in the app or by an earlier tap on
 * the same notice, and `resolveRunApproval` nulls the pending approval the
 * instant it is decided — is "no longer waiting" whatever the connection is
 * doing: there was never a decision to carry, so a gateway claim would be false.
 */
export function approvalRefusalReason(
  status: ConnectionStatus,
  data: unknown,
  pendingRunId: string | null,
): ApprovalRefusalReason | null {
  if (!isApprovalActionFor(data, pendingRunId ?? '')) return 'no-longer-waiting';
  return decisionCanReachGateway(status) ? null : 'unreachable';
}

/** The copy one refusal reason wears; the caller posts it unchanged. */
export interface ApprovalRefusalCopy {
  title: string;
  body: string;
}

const APPROVAL_REFUSAL_COPY: Record<ApprovalRefusalReason, ApprovalRefusalCopy> = {
  unreachable: {
    title: 'Approval not sent',
    body: "Couldn't reach the gateway — open Versutus to decide",
  },
  'no-longer-waiting': {
    title: 'Approval no longer waiting',
    body: 'This approval is no longer waiting. Open Versutus to see the run.',
  },
};

/**
 * The copy for a refusal. Both notices point the operator at the app, where the
 * run's own state is the truth; neither claims a run was decided, that the
 * gateway ran anything, nor carries a count of anything.
 */
export function approvalRefusalCopy(reason: ApprovalRefusalReason): ApprovalRefusalCopy {
  return APPROVAL_REFUSAL_COPY[reason];
}

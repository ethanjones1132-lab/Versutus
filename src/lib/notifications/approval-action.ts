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
// the caller posts an honest notice rather than pretending to have decided.

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

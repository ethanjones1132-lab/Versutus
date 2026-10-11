// ─── The Activity tab's read-only view of the decision audit ───────────────
// Activity does not need the full history Settings keeps; it needs the tally
// (N approved · M denied) and the newest few lines. Pure views over
// `ApprovalAuditEntry[]` so the tab stays wiring-free.

import { approvalAuditSummaryCopy, type ApprovalAuditEntry } from './approval-policy';

/** The inbox's companion sentence: what this device has already decided. */
export function approvalAuditTallyCopy(log: ApprovalAuditEntry[]): string {
  if (log.length === 0) return approvalAuditSummaryCopy(0);
  const approved = log.filter((entry) => entry.decision === 'approve').length;
  const denied = log.length - approved;
  return `${approved} approved · ${denied} denied.`;
}

/** The newest decisions first, capped — ready to render one line each.
    The persisted log is already newest first (appendApprovalAudit prepends);
    sorting by `at` descending still holds if the stored order ever differs. */
export function approvalAuditRecent(
  log: ApprovalAuditEntry[],
  limit: number,
): ApprovalAuditEntry[] {
  return [...log].sort((a, b) => b.at - a.at).slice(0, limit);
}

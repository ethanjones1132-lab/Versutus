// The D1 audit's read-back half: the "Recent decisions" card on the Activity
// tab. The append lives in `approval-audit.ts` and the provider's
// `resolveRunApproval`; this module folds the rows the screen reads back —
// verdict words from the rows, never invented, with the ADR-0008 fail-closed
// copy when no row can be read.

import type { ApprovalAuditEntry } from '@/lib/gateway/approval-audit';

export const APPROVAL_AUDIT_SECTION_TITLE = 'Recent decisions';

/** Fail-closed copy (ADR 0008): no row still names what was asked. */
export const APPROVAL_AUDIT_EMPTY_COPY =
  'No recorded decisions yet — a decision only lands here once made.';

export function approvalAuditRowCopy(row: ApprovalAuditEntry): string {
  const verdictWord = row.verdict === 'approve' ? 'Approved' : 'Denied';
  // A policy-decided row says the policy wrote it — the audit's honest
  // author line. Rows the operator decided (and every pre-policy row,
  // which carries no `decidedBy`) read exactly as they always did.
  const author = row.decidedBy === 'policy' ? ' by policy' : '';
  const prompt = row.prompt.trim();
  return prompt ? `${verdictWord}${author} · ${prompt}` : `${verdictWord}${author}`;
}

export function approvalAuditHeadingCopy(summary: {
  approveCount: number;
  denyCount: number;
}): string {
  return `${summary.approveCount} approved · ${summary.denyCount} denied`;
}

// ─── The approval inbox rows ──────────────────────────────────────────────
// The Gate's `approvals.pending` answer (D1) is a projection: every row is a
// pending CLI-environment approval with its class and one-line summary. This
// parses it into the shape the inbox renders. It fails closed — a row with no
// id is dropped, and an unfamiliar `type` reads as `unknown`, which the policy
// never auto-approves.

import { isAutoApprovable, normalizeApprovalClass, type ApprovalClass } from '@/lib/gateway/approval-policy';

export type ApprovalRow = {
  approvalId: string;
  cls: ApprovalClass;
  runId?: string;
  environmentId?: string;
  botId?: string;
  operation?: string;
  summary?: string;
  createdAt?: string;
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The list payload may arrive as `approvals` (Gate) or `pending`/`requests`. */
function collectionFrom(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  for (const key of ['approvals', 'pending', 'requests', 'items']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

export function approvalRowsFromUnknown(payload: unknown): ApprovalRow[] {
  const rows: ApprovalRow[] = [];
  for (const raw of collectionFrom(payload)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const approvalId = text(record.approvalId) ?? text(record.id);
    if (!approvalId) continue;
    rows.push({
      approvalId,
      cls: normalizeApprovalClass(record.type ?? record.risk ?? record.action ?? record.class),
      runId: text(record.runId),
      environmentId: text(record.environmentId),
      botId: text(record.botId),
      operation: text(record.operation),
      summary: text(record.summary) ?? text(record.description),
      createdAt: text(record.createdAt),
    });
  }
  return rows;
}

/** The inbox row's lead line: the Gate's summary, else an honest class line. */
export function approvalInboxCopy(row: ApprovalRow): string {
  if (row.summary) return row.summary;
  return `A ${approvalClassLabel(row.cls)} command needs your approval.`;
}

export function approvalClassLabel(cls: ApprovalClass): string {
  return cls.replace(/_/g, ' ');
}

/**
 * The rows a batch Approve may cover. Fail closed: only the class the Gate
 * already treats as safe (read-only) qualifies, so a batch control can never
 * sweep a destructive or unknown class through.
 */
export function batchApprovableRows(rows: ApprovalRow[]): ApprovalRow[] {
  return rows.filter((row) => isAutoApprovable(row.cls));
}

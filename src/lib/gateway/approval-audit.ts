// ─── Durable approval audit (D1) ───────────────────────────────────
// Every approval decision the app resolves is appended here, per gateway —
// the "audit log" FUTURE-ITEMS D1 names. The run API's approve/deny path and
// every Activity verdict row still work exactly as they did; this is the
// append-only record an operator can read later, on disk like the other
// durable copies (the `versutus:activity-runs` pattern in
// session-persistence.ts).

import { keyValueStorage } from '@/lib/storage/key-value';

export const APPROVAL_AUDIT_KEY_PREFIX = 'versutus:approval-audit:';

/** Cap so a long-lived install does not grow unbounded. */
export const APPROVAL_AUDIT_ROW_CAP = 50;

export type ApprovalVerdict = 'approve' | 'deny';

/**
 * One resolved decision: the run it belongs to, the operator's verdict, and
 * the gateway it was resolved against (the store's own scope).
 */
export type ApprovalAuditEntry = {
  gatewayId: string;
  runId: string;
  prompt: string;
  verdict: ApprovalVerdict;
  decidedAt: number;
};

type RawEntry = Record<string, unknown>;

/** The entry as it is held on disk: the audited fields, gateway scope stripped. */
function auditField(entry: ApprovalAuditEntry): RawEntry {
  return {
    runId: entry.runId,
    prompt: entry.prompt,
    verdict: entry.verdict,
    decidedAt: entry.decidedAt,
  };
}

function isAuditEntry(raw: unknown): raw is ApprovalAuditEntry {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as RawEntry;
  return (
    typeof r.runId === 'string' &&
    r.runId.length > 0 &&
    typeof r.prompt === 'string' &&
    typeof r.decidedAt === 'number' &&
    (r.verdict === 'approve' || r.verdict === 'deny')
  );
}

function auditKey(gatewayId: string): string {
  return `${APPROVAL_AUDIT_KEY_PREFIX}${gatewayId}`;
}

/**
 * Read one gateway's record back, newest-first. Rows the app did not shape
 * are dropped, not guessed, and the cap is enforced at load so a hand-made
 * larger file cannot unbound the surface. The stored rows are the audited
 * fields only — the gateway scope lives in the key.
 */
export async function loadApprovalAudit(gatewayId: string): Promise<ApprovalAuditEntry[]> {
  try {
    const raw = await keyValueStorage.getItem(auditKey(gatewayId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw as string);
    if (!Array.isArray(parsed)) return [];
    return (parsed.filter(isAuditEntry) as ApprovalAuditEntry[]).slice(0, APPROVAL_AUDIT_ROW_CAP);
  } catch {
    return [];
  }
}

/**
 * Append one decision to its gateway's audit. Best-effort: a failed record
 * loses one line of history, not the decision itself — the run API keeps
 * working. An empty gateway id is nowhere to record against.
 */
export async function recordApprovalDecision(entry: ApprovalAuditEntry): Promise<void> {
  const id = entry.gatewayId?.trim();
  if (!id) return;
  try {
    const existing = await loadApprovalAudit(id);
    const rows = [auditField(entry), ...existing].slice(0, APPROVAL_AUDIT_ROW_CAP);
    await keyValueStorage.setItem(auditKey(id), JSON.stringify(rows));
  } catch {
    // Append-only history is best-effort; never fail the decision over it.
  }
}

export type ApprovalAuditSummary = {
  approveCount: number;
  denyCount: number;
  latest: ApprovalAuditEntry | null;
};

export function approvalAuditSummary(rows: readonly ApprovalAuditEntry[]): ApprovalAuditSummary {
  let approveCount = 0;
  let denyCount = 0;
  let latest: ApprovalAuditEntry | null = null;
  for (const row of rows) {
    if (row.verdict === 'approve') approveCount += 1;
    else denyCount += 1;
    if (latest === null || row.decidedAt > latest.decidedAt) latest = row;
  }
  return { approveCount, denyCount, latest };
}

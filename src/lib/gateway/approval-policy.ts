// ─── Approval policies and the durable decision audit ─────────────────────
// D1 (`FUTURE-ITEMS.md`): the app can auto-approve a class of command for a
// Bot the operator trusts. The class comes from the Gate (its ApprovalService
// already fails closed on risk it does not know). This engine can only ever
// ADD decisions for the one class the Gate treats as safe — read-only — and a
// destructive or unknown class is never auto-approved, whether or not a policy
// exists. Policy and audit are THIS device's, held in key-value storage the way
// D5's budgets and P3's session labels are.

import { keyValueStorage } from '@/lib/storage/key-value';

/** The command classes the Gate's ApprovalService can hand us. */
export const APPROVAL_CLASSES = [
  'read',
  'workspace_write',
  'host_write',
  'credential',
  'install',
  'update',
  'plugin',
  'system',
  'destructive',
  'bypass',
  'unknown',
] as const;

export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

/**
 * Map the raw `type`/`action`/`risk` string the Gate sends onto a class.
 * Anything unrecognized is `unknown`, which the policy never auto-approves —
 * an unfamiliar risk must be confirmed, not guessed away.
 */
export function normalizeApprovalClass(raw: unknown): ApprovalClass {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!value) return 'unknown';
  if ((APPROVAL_CLASSES as readonly string[]).includes(value)) return value as ApprovalClass;
  if (value === 'read_only' || value === 'readonly') return 'read';
  if (value === 'write' || value === 'workspace' || value === 'file_write') return 'workspace_write';
  return 'unknown';
}

// ─── Policy storage ───────────────────────────────────────────────

/** The one key the policy blob is held under. */
export const APPROVAL_POLICIES_STORAGE_KEY = 'versutus:approval-policies';

/**
 * The only class a policy may auto-approve. Everything the Gate does not
 * already treat as safe stays behind the card, fail closed.
 */
export const AUTO_APPROVABLE_CLASSES: readonly ApprovalClass[] = ['read'];

export type ApprovalPolicy = { autoApproveRead: boolean };
export type ApprovalPolicies = Record<string, ApprovalPolicy>;

/** One Bot's identity inside the policy store; the budget-key rule. */
export function approvalPolicyKey(gatewayId: string, botId: string): string {
  return `${gatewayId}:${botId.replace(/[:/\\]/g, '_')}`;
}

export function approvalPoliciesFromUnknown(value: unknown): ApprovalPolicies {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const policies: ApprovalPolicies = {};
  for (const [key, policy] of Object.entries(value)) {
    if (
      policy
      && typeof policy === 'object'
      && (policy as ApprovalPolicy).autoApproveRead === true
    ) {
      policies[key] = { autoApproveRead: true };
    }
  }
  return policies;
}

/** Set or clear one Bot's opt-in. Off is a clear, not a stored false. */
export function setApprovalPolicy(
  policies: ApprovalPolicies,
  gatewayId: string,
  botId: string,
  enabled: boolean,
): ApprovalPolicies {
  const key = approvalPolicyKey(gatewayId, botId);
  const next = { ...policies };
  if (enabled) next[key] = { autoApproveRead: true };
  else delete next[key];
  return next;
}

export async function loadApprovalPolicies(): Promise<ApprovalPolicies> {
  try {
    const raw = await keyValueStorage.getItem(APPROVAL_POLICIES_STORAGE_KEY);
    if (!raw) return {};
    return approvalPoliciesFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export async function saveApprovalPolicies(policies: ApprovalPolicies): Promise<void> {
  try {
    await keyValueStorage.setItem(APPROVAL_POLICIES_STORAGE_KEY, JSON.stringify(policies));
  } catch {
    // best-effort: a policy must never break the surface that set it
  }
}

// ─── The decision ─────────────────────────────────────────────────

export type ApprovalDecision = { decision: 'approve' | 'ask'; reason: string };

export function isAutoApprovable(cls: ApprovalClass): boolean {
  return AUTO_APPROVABLE_CLASSES.includes(cls);
}

/** The per-Bot opt-in's line; the toggle is the only way to turn it on. */
export function approvalPolicyCopy(enabled: boolean): string {
  return enabled
    ? 'Read-only commands run without a card for this Bot. Everything else still asks.'
    : 'This Bot asks before every command.';
}

/**
 * Decide one pending approval. Fail closed at every branch: an unfamiliar or
 * dangerous class is never approved, a missing policy asks, and only an
 * explicit per-Bot opt-in lets the one safe class through.
 */
export function approvalPolicyDecision({
  policies,
  gatewayId,
  botId,
  cls,
}: {
  policies: ApprovalPolicies;
  gatewayId: string;
  botId?: string;
  cls: ApprovalClass;
}): ApprovalDecision {
  if (!isAutoApprovable(cls)) {
    return { decision: 'ask', reason: `${cls} is never auto-approved; confirm it yourself.` };
  }
  if (!botId) return { decision: 'ask', reason: 'No Bot is named, so no policy applies.' };
  const optedIn = policies[approvalPolicyKey(gatewayId, botId)]?.autoApproveRead === true;
  if (!optedIn) return { decision: 'ask', reason: 'No policy auto-approves this Bot.' };
  return { decision: 'approve', reason: 'Read-only, and this Bot is trusted for read-only commands.' };
}

// ─── Durable audit ────────────────────────────────────────────────

export const APPROVAL_AUDIT_STORAGE_KEY = 'versutus:approval-audit';
export const APPROVAL_AUDIT_CAP = 200;

export type ApprovalAuditEntry = {
  approvalId: string;
  runId?: string;
  botId?: string;
  cls: ApprovalClass;
  decision: 'approve' | 'deny';
  source: 'operator' | 'policy';
  at: number;
};

function isAuditEntry(value: unknown): value is ApprovalAuditEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ApprovalAuditEntry>;
  return (
    typeof entry.approvalId === 'string'
    && entry.approvalId.length > 0
    && (entry.decision === 'approve' || entry.decision === 'deny')
    && (entry.source === 'operator' || entry.source === 'policy')
    && typeof entry.at === 'number'
    && Number.isFinite(entry.at)
  );
}

export function approvalAuditFromUnknown(value: unknown): ApprovalAuditEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isAuditEntry).slice(0, APPROVAL_AUDIT_CAP);
}

/** Newest first, capped. */
export function appendApprovalAudit(
  log: ApprovalAuditEntry[],
  entry: ApprovalAuditEntry,
): ApprovalAuditEntry[] {
  return [entry, ...log].slice(0, APPROVAL_AUDIT_CAP);
}

export async function loadApprovalAudit(): Promise<ApprovalAuditEntry[]> {
  try {
    const raw = await keyValueStorage.getItem(APPROVAL_AUDIT_STORAGE_KEY);
    if (!raw) return [];
    return approvalAuditFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

/** One audit row's line: what happened, to which class, decided how. */
export function approvalAuditCopy(entry: ApprovalAuditEntry): string {
  const verb =
    entry.source === 'policy' ? 'Auto-approved' : entry.decision === 'approve' ? 'Approved' : 'Denied';
  return `${verb} · ${entry.cls} · ${entry.source}`;
}

/** The history card's empty/live sentence. */
export function approvalAuditSummaryCopy(count: number): string {
  if (count === 0) return 'No approval decisions recorded on this device yet.';
  return `${count} decision${count === 1 ? '' : 's'} recorded on this device.`;
}

/** Append one decision. Best-effort: an audit write must never block a call. */
export async function recordApprovalDecision(entry: ApprovalAuditEntry): Promise<void> {
  try {
    const log = await loadApprovalAudit();
    await keyValueStorage.setItem(
      APPROVAL_AUDIT_STORAGE_KEY,
      JSON.stringify(appendApprovalAudit(log, entry)),
    );
  } catch {
    // best-effort
  }
}

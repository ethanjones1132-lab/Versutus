// ─── Per-Bot approval policies (D1) — the store ───────────────────────────
// Policy state is phone-side key-value storage, shaped like the spend-cap
// store (`bot-spend-cap.ts`); the verdict fold and copy live in the pure
// sibling `approval-policy.ts`, which code that cannot load native storage
// imports instead.

import { keyValueStorage } from '@/lib/storage/key-value';
import type { ApprovalPolicy } from '@/lib/settings/approval-policy';

export { approvalPolicyVerdict, APPROVAL_POLICY_LIMIT_COPY, type ApprovalPolicy, type ApprovalPolicyVerdict } from '@/lib/settings/approval-policy';

/** One store for every gateway, one key per Bot — the last-seen pattern. */
const POLICY_KEY_PREFIX = 'versutus:approval-policy:';

function policyKey(botId: string): string {
  return `${POLICY_KEY_PREFIX}${botId}`;
}

function isPolicy(raw: unknown): raw is ApprovalPolicy {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.enabled === 'boolean' &&
    Array.isArray(r.readOnlyCommands) &&
    r.readOnlyCommands.every((command) => typeof command === 'string')
  );
}

/**
 * Set (or clear, with a disabled/empty policy) one Bot's policy. A blank id
 * stores nothing — there is no Bot the policy could govern. Written rows
 * are validated on the way in, so garbage never becomes a policy nobody
 * wrote.
 */
export async function setBotApprovalPolicy(botId: string, policy: ApprovalPolicy | null): Promise<void> {
  const id = botId.trim();
  if (!id) return;
  try {
    if (!policy || !isPolicy(policy)) {
      await keyValueStorage.removeItem(policyKey(id));
    } else {
      const stored: ApprovalPolicy = {
        enabled: policy.enabled,
        readOnlyCommands: policy.readOnlyCommands.filter((command) => command.trim().length > 0),
      };
      await keyValueStorage.setItem(policyKey(id), JSON.stringify(stored));
    }
  } catch {
    // best-effort: a failed write only leaves the old policy standing.
  }
}

/**
 * Read one Bot's policy, or null when none is set. A corrupt stored value
 * is unknown, not a disabled policy — an unreadable policy defers every
 * decision to the human, the fail-closed direction.
 */
export async function loadBotApprovalPolicy(botId: string): Promise<ApprovalPolicy | null> {
  const id = botId.trim();
  if (!id) return null;
  try {
    const raw = await keyValueStorage.getItem(policyKey(id));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw as string);
    return isPolicy(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Approval policies (D1's policy half), pure ───────────────────────────
// The half of a per-Bot approval policy that must import nothing: the
// pre-decision fold and the copy its surfaces state, shaped like the
// spend-cap verdict sibling (`spend-cap-verdict.ts`). The storage sibling
// `bot-approval-policy.ts` owns the key-value read; the provider consumes
// the fold at the approval-waiting point, never a fetch inside.
//
// Fail-closed discipline (ADR 0008) applied to consent: a policy can only
// ever ADD an auto-approve, never widen it — a prompt matching nothing on
// the read-only list defers to the human, exactly as before.

export type ApprovalPolicy = {
  /** Opt-in per Bot: an off policy decides nothing. */
  enabled: boolean;
  /**
   * The read-only commands a prompt must MATCH to be auto-approved — the
   * allow-list of verbs/commands the operator trusted this Bot with.
   */
  readOnlyCommands: string[];
};

export type ApprovalPolicyVerdict = { decision: 'auto-approve' } | { decision: 'defer' };

/**
 * The match is whole-word, not substring: a prompt that merely CONTAINS a
 * listed command's letters (`listen` inside `list`) never auto-approves.
 * Case-insensitive, because a command is what a Bot typed, not a cipher.
 * Anything not matching defers — a prompt matching nothing is still shown,
 * it is simply not decided by policy.
 */
function promptMatchesReadOnly(prompt: string, command: string): boolean {
  const words = prompt
    .toLowerCase()
    .split(/[^a-z0-9:_-]+/)
    .map((word) => word.replace(/:$/, '')) // `journal:` names the command `journal`
    .filter(Boolean);
  return words.includes(command.trim().toLowerCase());
}

export function approvalPolicyVerdict(
  policy: ApprovalPolicy | null,
  prompt: string,
): ApprovalPolicyVerdict {
  if (!policy?.enabled || policy.readOnlyCommands.length === 0) return { decision: 'defer' };
  const cleaned = prompt.trim();
  if (!cleaned) return { decision: 'defer' };
  for (const command of policy.readOnlyCommands) {
    if (!command.trim()) continue;
    if (promptMatchesReadOnly(cleaned, command)) return { decision: 'auto-approve' };
  }
  return { decision: 'defer' };
}

/** The honest framing every policy surface states: what the list can cover. */
export const APPROVAL_POLICY_LIMIT_COPY =
  'Auto-approves only what the read-only list names, for this agent only.';

/**
 * The editor's draft fold: the commands text an operator typed plus the
 * toggle's position become the one policy the store accepts. Splits on
 * commas and whitespace, trims, drops the tokens that empty out, and
 * dedupes case-insensitively — the same whole-word, case-free vocabulary
 * `promptMatchesReadOnly` reads. A draft whose tokens all drop answers
 * null: nothing for the policy to govern, so the caller clears rather
 * than stores a word the verdict would always defer.
 */
export function approvalPolicyDraft(text: string, enabled: boolean): ApprovalPolicy | null {
  const seen = new Set<string>();
  const readOnlyCommands: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    const cleaned = token.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    readOnlyCommands.push(cleaned);
  }
  if (readOnlyCommands.length === 0) return null;
  return { enabled, readOnlyCommands };
}

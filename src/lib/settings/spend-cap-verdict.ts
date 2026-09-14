// ─── Spend-cap verdict (D5), pure ─────────────────────────────────
// The half of the per-Bot spend cap that must import nothing: the verdict
// fold and the notice copy. slash-commands consumes THIS module, never the
// storage sibling, so a suite that imports the executorraw does not load
// AsyncStorage outside any mock (the iter-002 lesson).

export type SpendCapVerdict =
  | { decision: 'allow' }
  | { decision: 'pause-and-escalate'; reason: 'cap-met'; spendUsd: number; capUsd: number }
  | { decision: 'pause-and-escalate'; reason: 'unreadable-spend'; capUsd: number };

/**
 * The pre-run verdict: allow, or pause-and-escalate.
 *
 * `spendUsd` is what the spend read reports for this Bot. A spent amount
 * AT or past the cap pauses the run — the hard stop is the cap met, not
 * exceeded, because a run started past it is exactly the thing being
 * stopped. A spend nobody read (`null` or not a finite number) can never
 * be judged under a cap it was never measured against, so it escalates
 * rather than silently allowing more spend; no cap set is simply an
 * allow, the existing behavior a device without caps keeps.
 */
export function spendCapVerdict(capUsd: number | null, spendUsd: number | null): SpendCapVerdict {
  if (capUsd == null || !Number.isFinite(capUsd)) return { decision: 'allow' };
  if (spendUsd == null || !Number.isFinite(spendUsd)) {
    return { decision: 'pause-and-escalate', reason: 'unreadable-spend', capUsd };
  }
  if (spendUsd >= capUsd) {
    return { decision: 'pause-and-escalate', reason: 'cap-met', spendUsd, capUsd };
  }
  return { decision: 'allow' };
}

/** The escalation-shaped notice copy: what was paused, and why. */
export function spendCapNoticeCopy(verdict: SpendCapVerdict & { decision: 'pause-and-escalate' }): string {
  if (verdict.reason === 'unreadable-spend') {
    return `Spend cap $${verdict.capUsd.toFixed(2)} in force — the run was paused because this device could not read the Bot's spend.`;
  }
  return `Spend cap reached — $${verdict.spendUsd.toFixed(2)} of $${verdict.capUsd.toFixed(2)}. The run was paused for your decision.`;
}

/** The honest-limit copy the cap's own surface must state (D5's own line). */
export const SPEND_CAP_LIMIT_COPY =
  'Caps govern runs started from this app — there is no server-side quota.';

/**
 * What the cap row's editor hands the store: a typed answer becomes a cap
 * number, anything that is not a cap becomes `null` — the store's own
 * clear path, so a blank field clears the cap and garbage stores nothing
 * rather than becoming a policy nobody wrote. A `$` prefix and interior
 * commas strip first: they are how a dollar figure is written, not part
 * of the number it names.
 */
export function parseSpendCapInput(text: string): number | null {
  const digits = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

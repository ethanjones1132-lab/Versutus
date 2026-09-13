// ─── Per-Bot spend caps, enforced before a run starts ─────────────────────
// D5 (`FUTURE-ITEMS.md`): a Bot gets a spend cap; a run over it does not
// start. No gateway route carries a budget, so the cap is THIS device's,
// held in key-value storage the way P3's session labels are, and the check
// is client-side — it governs runs started from this app, not a server quota.
//
// The honesty rules are the same as P3's: a cap must be a positive finite
// number or it is not a cap, a junk store reads as no budgets, and a spend
// read that FAILS is unknown rather than "over" — the run is allowed and the
// cap is still named, because refusing a run on a read the device could not
// make would be pretending to an enforcement the app did not perform.

import { sessionSpendReadFromUnknown } from '@/lib/gateway/session-analytics';
import { botSpendRows } from '@/lib/gateway/spend-report';
import { keyValueStorage } from '@/lib/storage/key-value';

/** The one key the budget blob is held under. */
export const BUDGETS_STORAGE_KEY = 'versutus:bot-budgets';

/** Caps keyed by `budgetKey`, in US dollars. */
export type BotBudgets = Record<string, number>;

/** One Bot's identity inside the budget store; the session-label key rule. */
export function budgetKey(gatewayId: string, botId: string): string {
  return `${gatewayId}:${botId.replace(/[:/\\]/g, '_')}`;
}

/** The cap for a Bot, or undefined when it has none. */
export function botBudget(budgets: BotBudgets, gatewayId: string, botId: string): number | undefined {
  const value = budgets[budgetKey(gatewayId, botId)];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Set or clear one Bot's cap. A non-positive cap is a clear, not a store. */
export function setBotBudget(
  budgets: BotBudgets,
  gatewayId: string,
  botId: string,
  cap: number | undefined,
): BotBudgets {
  const key = budgetKey(gatewayId, botId);
  const next = { ...budgets };
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) next[key] = cap;
  else delete next[key];
  return next;
}

/** Read the stored blob, keeping only positive finite caps. */
export function budgetsFromUnknown(value: unknown): BotBudgets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const budgets: BotBudgets = {};
  for (const [key, cap] of Object.entries(value)) {
    if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) budgets[key] = cap;
  }
  return budgets;
}

export type BudgetVerdict =
  | { allowed: true; cap?: number; spent?: number }
  | { allowed: false; cap: number; spent: number; overBy: number; reason: string };

/**
 * Decide one run. No cap allows. A spend number that is missing or not
 * finite reads as zero, not as "over". At exactly the cap the run is allowed.
 */
export function evaluateBudget(
  cap: number | undefined,
  spent: number | null | undefined,
): BudgetVerdict {
  const hasCap = typeof cap === 'number' && Number.isFinite(cap) && cap > 0;
  const spentValue = typeof spent === 'number' && Number.isFinite(spent) ? spent : 0;
  if (!hasCap) return { allowed: true };
  if (spentValue <= cap) return { allowed: true, cap, spent: spentValue };
  const overBy = spentValue - cap;
  return {
    allowed: false,
    cap,
    spent: spentValue,
    overBy,
    reason: `This Bot has spent $${spentValue.toFixed(2)} of its $${cap.toFixed(2)} budget. Raise its cap or run it elsewhere.`,
  };
}

/**
 * The pre-run guard. `readSpend` fetches the Bot's current spend; an absent
 * cap or a failed read allows the run.
 */
export async function checkBotBudget({
  budgets,
  gatewayId,
  botId,
  readSpend,
}: {
  budgets: BotBudgets;
  gatewayId: string;
  botId: string;
  readSpend: () => Promise<number | null>;
}): Promise<BudgetVerdict> {
  const cap = botBudget(budgets, gatewayId, botId);
  if (cap === undefined) return { allowed: true };
  let spent: number | null = null;
  try {
    spent = await readSpend();
  } catch {
    // Unknown is not over: allow the run, but the cap is still named.
    return { allowed: true, cap, spent: undefined };
  }
  return evaluateBudget(cap, spent);
}

/** The Spend row's budget line: the cap, or an honest "no cap". */
export function budgetRowCopy(cap: number | undefined): string {
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0
    ? `Budget $${cap.toFixed(2)}`
    : 'No budget';
}

/**
 * The cost one scoped `sessions.list` payload reports for a Bot, folded by
 * the same rule the Spend surface prints. A read with no cost fields is 0
 * here — the caller decides whether an unknown spend is a stop.
 */
export function botSpendFromSessions(botId: string, payload: unknown): number {
  const row = botSpendRows([
    { botId, label: botId, read: sessionSpendReadFromUnknown(payload) },
  ])[0];
  return row?.costUsd ?? 0;
}

/** Read every stored cap. A refused or unreadable store is no caps. */
export async function loadBudgets(): Promise<BotBudgets> {
  try {
    const raw = await keyValueStorage.getItem(BUDGETS_STORAGE_KEY);
    if (!raw) return {};
    return budgetsFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** Write the cap set back. Best-effort, like the session labels. */
export async function saveBudgets(budgets: BotBudgets): Promise<void> {
  try {
    await keyValueStorage.setItem(BUDGETS_STORAGE_KEY, JSON.stringify(budgets));
  } catch {
    // best-effort: a cap must never break the surface that set it
  }
}

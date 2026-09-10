import { formatCost, formatTokenCount } from '@/lib/format';
import {
  SESSION_SPEND_LIST_LIMIT,
  sessionSpendReadFromUnknown,
  sessionUsage,
  totalUsage,
  type SessionSpendRead,
  type SessionUsageInput,
} from '@/lib/gateway/session-analytics';

/**
 * P5's per-Bot breakdown, as rows.
 *
 * A Hermes session belongs to exactly one Bot (CONTEXT.md), and the roster
 * already knows every one of them — but no single read the app makes answers
 * "what did each Bot cost?". The Gate's `session.usage` totals the catalogue
 * without any cost field at all and the RPC dispatches by METHOD, so the Bot
 * never reaches the resolver; the caller therefore injects the reads
 * (`readBotSpend`) and this module folds each one with the helpers the
 * thread glance already uses — `sessionUsage` and `totalUsage`. No second
 * aggregation lives here.
 *
 * A spend surface is a claim, so this module refuses three things:
 *   - a number never travels without its basis (`actual` / `estimated` /
 *     `none`), so an estimate is never read as a bill;
 *   - a failed read is named (`SPEND_UNREAD_COPY`) and carries no number at
 *     all — a zero would read as "this Bot is free";
 *   - a fold that mixes an actual with an estimate is labelled `estimated`,
 *     the weaker claim rather than the stronger one.
 */

/** How the cost a row shows was reported. */
export type SpendCostBasis = 'actual' | 'estimated' | 'none';

/** One Bot's read, as the caller produced it: a roster entry and its payload. */
export type BotSpendRead = { botId: string; label?: string; read: SessionSpendRead };

export type BotSpendRow = {
  botId: string;
  /** The roster name, falling back to the id — a row is never anonymous. */
  label: string;
  /**
   * `null` only when the read failed: the basis is then unknown, which is not
   * the same fact as `none` ("the read answered, with no cost fields").
   */
  basis: SpendCostBasis | null;
  /** `null` on a failed read; a real count otherwise, zero included. */
  tokens: number | null;
  costUsd: number | null;
  failed: boolean;
};

/**
 * The sentence the failure already has in this app: `threadSpendCopy` names a
 * failed first read the same way, so the operator reads one wording for one
 * fact wherever spend is missing.
 */
export const SPEND_UNREAD_COPY = 'Spend could not be read.';

/**
 * Which of the two discipline rules P5 inherits this fold falls under.
 *
 * `none` means "the read answered and carried no cost fields" — the Gate's
 * bare catalogue shape — so the surface shows tokens only and says why.
 * `estimated` covers a mix on purpose: a total that contains any estimate may
 * not claim to be a bill, so the weaker basis wins.
 */
export function spendCostBasis(sessions: SessionUsageInput[]): SpendCostBasis {
  let costed = false;
  let estimated = false;
  for (const session of sessions) {
    // The same selection sessionUsage makes, so a basis can never disagree
    // with the cost the row prints: a finite `actual_cost_usd` wins, anything
    // else means the number came from the estimate beside it.
    const usage = sessionUsage(session);
    if (usage.costUsd == null) continue;
    costed = true;
    const actual = session.actual_cost_usd;
    if (!(typeof actual === 'number' && Number.isFinite(actual))) estimated = true;
  }
  if (!costed) return 'none';
  return estimated ? 'estimated' : 'actual';
}

/**
 * The header line for a basis — what the number under it means, not a total.
 * A cost-less read says why it shows no cost instead of leaving the operator
 * to guess that nothing was spent.
 */
export function spendBasisCopy(basis: SpendCostBasis): string {
  if (basis === 'actual') return 'Costs shown are actual charges';
  if (basis === 'estimated') return 'Costs shown are estimated';
  return 'Tokens only — this gateway reported no cost fields';
}

/**
 * One Bot's row line. The failure is named; a costed row prints its basis
 * beside the number, so no row can be read as a bill it is not.
 */
export function botSpendRowCopy(row: BotSpendRow): string {
  if (row.failed) return SPEND_UNREAD_COPY;
  const tokens = `${formatTokenCount(row.tokens ?? 0)} tokens`;
  if (row.costUsd == null) return `${tokens} · no cost fields in this read`;
  return `${tokens} · ${formatCost(row.costUsd)} (${row.basis})`;
}

/**
 * The roster entry this module needs: an id, and the Gate's name for it when
 * one was reported. `PublicBot` satisfies it without the fold depending on
 * every field a roster row carries.
 */
export type BotSpendRosterEntry = { id: string; displayName?: string };

/**
 * The two reads a per-Bot report is made of, injected so the fold stays a
 * pure function of what the caller fetched.
 *
 * `readBotSessions` is optional because the capability is: an adapter that
 * cannot scope a catalogue by Bot omits it, and that absence — known before
 * a request that could only be refused — is what makes the report degrade
 * to the gateway total alone rather than provoke an error.
 */
export type BotSpendSource = {
  listBots: () => Promise<BotSpendRosterEntry[]>;
  readBotSessions?: (botId: string, limit: number) => Promise<unknown>;
};

export type BotSpendReport = {
  rows: BotSpendRow[];
  /**
   * True when the gateway could not be asked per Bot at all. Not the same
   * fact as an empty roster: one has no per-Bot section because the
   * capability is missing, the other because there are no Bots — and the
   * section's copy has to differ.
   */
  degraded: boolean;
};

/**
 * One scoped catalogue read per roster Bot, folded into rows.
 *
 * The reads run one at a time: each is the 200-row catalogue and the roster
 * is short, so a screen open is a few GETs, while a burst in parallel from a
 * phone is exactly the load `withGetSessionsRetry`'s backoff exists to
 * absorb.
 *
 * A Bot whose read is refused or unreachable is caught here and kept as a
 * named `{ ok: false }` read — dropping it would read as a Bot that spent
 * nothing. A read that answers with something that is not a session list is
 * the same failure, decided by `sessionSpendReadFromUnknown`.
 */
export async function readBotSpend(source: BotSpendSource): Promise<BotSpendReport> {
  const readBotSessions = source.readBotSessions;
  if (!readBotSessions) return { rows: [], degraded: true };
  const roster = await source.listBots();
  const reads: BotSpendRead[] = [];
  for (const bot of roster) {
    try {
      const payload = await readBotSessions(bot.id, SESSION_SPEND_LIST_LIMIT);
      reads.push({
        botId: bot.id,
        label: bot.displayName,
        read: sessionSpendReadFromUnknown(payload),
      });
    } catch {
      reads.push({ botId: bot.id, label: bot.displayName, read: { ok: false } });
    }
  }
  return { rows: botSpendRows(reads), degraded: false };
}

/**
 * One row per Bot, biggest spend first. A row with no readable cost goes
 * below every costed one, in roster order, because "unknown" is not "cheap" —
 * and the sort is stable, so equal costs keep the roster's own order rather
 * than reshuffling on every read.
 */
export function botSpendRows(reads: BotSpendRead[]): BotSpendRow[] {
  const rows = reads.map((entry): BotSpendRow => {
    const label = entry.label?.trim() || entry.botId;
    if (!entry.read.ok) {
      return { botId: entry.botId, label, basis: null, tokens: null, costUsd: null, failed: true };
    }
    const spend = totalUsage(entry.read.sessions);
    return {
      botId: entry.botId,
      label,
      basis: spendCostBasis(entry.read.sessions),
      tokens: spend.tokens,
      costUsd: spend.costUsd,
      failed: false,
    };
  });
  return rows.sort((left, right) => {
    if (left.costUsd == null && right.costUsd == null) return 0;
    if (left.costUsd == null) return 1;
    if (right.costUsd == null) return -1;
    return right.costUsd - left.costUsd;
  });
}

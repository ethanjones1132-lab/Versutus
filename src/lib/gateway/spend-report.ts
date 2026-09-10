import { formatCost, formatRelativeTime, formatTokenCount } from '@/lib/format';
import {
  SESSION_SPEND_LIST_LIMIT,
  sessionSpendReadFromUnknown,
  sessionUsage,
  toEpochMs,
  totalUsage,
  type SessionSpendRead,
  type SessionUsageInput,
} from '@/lib/gateway/session-analytics';

/**
 * P5's per-Bot breakdown and per-session table, as rows.
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
 * The amount line every row in this module prints: the tokens this read
 * carried, then the cost with the basis it is claimed on. One expression means
 * a session row and a Bot row can never word the same fact differently — and a
 * read with no cost fields says why it shows no cost, rather than leaving the
 * operator to guess that nothing was spent.
 */
function spendAmountCopy(tokens: number, costUsd: number | null, basis: SpendCostBasis | null): string {
  const amount = `${formatTokenCount(tokens)} tokens`;
  if (costUsd == null) return `${amount} · no cost fields in this read`;
  return `${amount} · ${formatCost(costUsd)} (${basis})`;
}

/**
 * One Bot's row line. The failure is named; a costed row prints its basis
 * beside the number, so no row can be read as a bill it is not.
 */
export function botSpendRowCopy(row: BotSpendRow): string {
  if (row.failed) return SPEND_UNREAD_COPY;
  return spendAmountCopy(row.tokens ?? 0, row.costUsd, row.basis);
}

/**
 * What the per-Bot rows were read over, and the cap each one stopped at.
 *
 * Every row is folded from its own scoped catalogue read, and `readBotSpend`
 * asks each roster Bot at `SESSION_SPEND_LIST_LIMIT` — the same 200-row cap
 * the gateway total is read at. The list endpoint takes a `limit` but no
 * cursor, so a Bot with a longer history than the cap has its number
 * understated by exactly the sessions that were never returned, and the
 * section has to say so.
 *
 * The sentence is about the READ, not about any one Bot's count: the fold
 * keeps one read per Bot and no per-row count to compare a cap against, so
 * unlike `spendSessionCapCopy` — which captions a single read and can name
 * its own size — this one states the bound every row was read at.
 */
export function botSpendCapCopy(limit: number): string {
  return `Each Bot is read over its newest ${limit} sessions — a longer history is past the cap, so its number is understated`;
}

/**
 * Why a per-Bot section is missing at all. A gateway that cannot be asked per
 * Bot is a different fact from a roster with no Bots — that one renders no
 * section, this one says so under a total it could still read.
 */
export const SPEND_PER_BOT_DEGRADED_COPY = 'This gateway cannot split spend by Bot.';

/**
 * The basis every row agrees on, or `null` when they do not.
 *
 * The section keeps one header line, and a header is only honest when it is
 * true of every row under it — so a roster mixing an actual charge with an
 * estimate gets no header at all and lets each row's own basis speak.
 *
 * A failed row carries `null`, which is unknown rather than `none`: it is
 * skipped, never counted, so an all-failed roster writes no header. `none`
 * itself counts — "this gateway reported no cost fields" is a basis a whole
 * roster can share.
 */
export function botSpendSectionBasis(rows: BotSpendRow[]): SpendCostBasis | null {
  let shared: SpendCostBasis | null = null;
  for (const row of rows) {
    if (row.failed || row.basis == null) continue;
    if (shared == null) shared = row.basis;
    else if (shared !== row.basis) return null;
  }
  return shared;
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
  return rows.sort(byCostDesc);
}

/**
 * The ordering both spend folds share: biggest cost first, and a row whose
 * cost could not be read below every costed one, because "unknown" is not
 * "cheap". `Array.prototype.sort` is stable, so equal costs keep the read's
 * own order instead of reshuffling on every render.
 */
function byCostDesc(left: { costUsd: number | null }, right: { costUsd: number | null }): number {
  if (left.costUsd == null && right.costUsd == null) return 0;
  if (left.costUsd == null) return 1;
  if (right.costUsd == null) return -1;
  return right.costUsd - left.costUsd;
}

/**
 * The per-session table's rows: the same `SessionUsageInput` rows the gateway
 * total folded (`totalUsage`, one read), one line each, biggest cost first.
 *
 * A session is named by its id — CONTEXT.md identifies a session by its
 * sessionId — and a read that carried no id reads as `Untitled`, the word the
 * session selector already prints (`sessionListTitle`), never an anonymous
 * row. `key` exists because two unnamed rows are still two rows: the label can
 * repeat, the key cannot.
 *
 * `lastActiveMs` is the read's `last_active` normalised by the analytics
 * module's own `toEpochMs`, or `null` when the row carried no timestamp, which
 * is not the same fact as an old one — a missing timestamp prints no recency
 * at all rather than "just now".
 */
export type SpendSessionRow = {
  /** List identity: the session id, or its place in the read when it had none. */
  key: string;
  /** The session id, or `Untitled` — a row is never anonymous. */
  label: string;
  tokens: number;
  costUsd: number | null;
  basis: SpendCostBasis;
  lastActiveMs: number | null;
};

export function spendSessionRows(sessions: SessionUsageInput[]): SpendSessionRow[] {
  const rows = sessions.map((session, index): SpendSessionRow => {
    const id = session.id?.trim();
    const usage = sessionUsage(session);
    return {
      key: id || `unnamed-${index + 1}`,
      label: id || 'Untitled',
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      basis: spendCostBasis([session]),
      lastActiveMs:
        typeof session.last_active === 'number' && Number.isFinite(session.last_active)
          ? toEpochMs(session.last_active)
          : null,
    };
  });
  return rows.sort(byCostDesc);
}

/**
 * One session's line: its amount, then how long ago it ran. No number travels
 * without its basis, and a read with no timestamp prints no recency rather
 * than a fabricated one.
 */
export function spendSessionRowCopy(row: SpendSessionRow): string {
  const amount = spendAmountCopy(row.tokens, row.costUsd, row.basis);
  return row.lastActiveMs == null ? amount : `${amount} · ${formatRelativeTime(row.lastActiveMs)}`;
}

/**
 * What the table lists, and how much of the catalogue that is.
 *
 * The list endpoint takes a `limit` but no cursor (`spendWindowCopy`'s note),
 * so a full read has sessions missing off the end and says so instead of
 * reading as the whole catalogue; a partial read is everything this device
 * could see, and claims no bound it did not hit. Callers pass the read's ROW
 * count — `SessionSpendState.rowCount` — so a capped read names its cap even
 * when a row it could not parse was dropped from the rows listed.
 */
export function spendSessionCapCopy(sessionCount: number): string {
  if (Number.isFinite(sessionCount) && sessionCount >= SESSION_SPEND_LIST_LIMIT) {
    return `Newest ${SESSION_SPEND_LIST_LIMIT} sessions — older sessions are past the list's cap`;
  }
  return `${sessionCount} sessions in this read`;
}

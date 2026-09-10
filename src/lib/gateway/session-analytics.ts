import { formatCost, formatTokenCount } from '@/lib/format';

export type SessionUsageInput = {
  id?: string;
  input_tokens?: number;
  output_tokens?: number;
  actual_cost_usd?: number | null;
  estimated_cost_usd?: number | null;
  last_active?: number;
};

export type SessionUsage = { tokens: number; costUsd: number | null };

export type SessionSpend = {
  sessionCount: number;
  tokens: number;
  costUsd: number | null;
};

export type SessionSpendRead =
  | {
      ok: true;
      sessions: SessionUsageInput[];
      /**
       * How many rows the payload held, parsed or not. A row that is not a
       * record carries no spend to fold, so `sessions` may be shorter than the
       * read — but a read that took the endpoint's whole cap hit that cap
       * either way, and a bound line must read this.
       */
      rowCount: number;
    }
  | { ok: false };

/**
 * Visible spend after folding a sessions.list read. Two failures are not
 * the same fact:
 *   - A failed FIRST read claims zero knowledge — not zero spend.
 *   - A failed RE-read keeps the last good list and marks it stale.
 * Only a successful read may clear or replace the list.
 */
export type SessionSpendState = {
  sessions: SessionUsageInput[];
  /**
   * Rows the last successful read held (`SessionSpendRead.rowCount`), which is
   * not `sessions.length`: a row with nothing to parse is dropped, and a
   * retained last-good list keeps the count it was read at. A bound line reads
   * this, so a capped read names its cap even when a row could not be parsed.
   */
  rowCount: number;
  /** True once a successful read has landed. */
  loaded: boolean;
  failed: boolean;
};

export const EMPTY_SESSION_SPEND: SessionSpendState = {
  sessions: [],
  rowCount: 0,
  loaded: false,
  failed: false,
};

export type WeekBucket = { startMs: number; tokens: number; costUsd: number };

export type RelativeMeter = { value: number; peak: number; ratio: number };

/**
 * Epoch milliseconds for a timestamp a read carried. A read reports seconds or
 * milliseconds and this is the app's one rule for telling them apart — the
 * same threshold `formatRelativeTime` (`src/lib/format.ts:22`) already applies
 * — so a fold that reads `last_active` cannot disagree with the formatter that
 * prints it.
 */
export function toEpochMs(timestamp: number): number {
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function startOfLocalDay(ms: number): number {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

export function sessionUsage(session: SessionUsageInput): SessionUsage {
  const input = typeof session.input_tokens === 'number' && Number.isFinite(session.input_tokens) ? session.input_tokens : 0;
  const output = typeof session.output_tokens === 'number' && Number.isFinite(session.output_tokens) ? session.output_tokens : 0;
  const tokens = Math.max(0, input + output);
  const cost = session.actual_cost_usd ?? session.estimated_cost_usd;
  return { tokens, costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null };
}

export function totalUsage(sessions: SessionUsageInput[]): SessionSpend {
  let tokens = 0;
  let costSum = 0;
  let hasCost = false;
  for (const session of sessions) {
    const usage = sessionUsage(session);
    tokens += usage.tokens;
    if (usage.costUsd != null) {
      costSum += usage.costUsd;
      hasCost = true;
    }
  }
  return { sessionCount: sessions.length, tokens, costUsd: hasCost ? costSum : null };
}

export function sessionSpendCopy(spend: SessionSpend): string {
  return [
    `Sessions: ${spend.sessionCount}`,
    `Tokens: ${formatTokenCount(spend.tokens)}`,
    `Cost: ${spend.costUsd == null ? '—' : formatCost(spend.costUsd)}`,
  ].join('\n');
}

/**
 * Parse a `session.usage` RPC payload into the spend `/usage` already
 * renders. The Gate answers two shapes behind the one method
 * (`gate/core/capabilities/gateway-methods.mjs:218-229`): bare catalogue
 * totals (`{ sessions, input_tokens, output_tokens, ... }`, no cost fields)
 * without an id, and one Session's counters (`{ sessionId, input_tokens,
 * output_tokens, actual_cost_usd, estimated_cost_usd, ... }`) with one.
 * Anything else is not a usage read — null, so the caller keeps today's
 * title-and-Raw fallback instead of printing a spend line over it.
 */
export function sessionUsageSpendFromUnknown(raw: unknown): SessionSpend | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.sessions === 'number' && Number.isFinite(raw.sessions)) {
    const input = numberField(raw, 'input_tokens') ?? 0;
    const output = numberField(raw, 'output_tokens') ?? 0;
    const cost = costField(raw, 'actual_cost_usd') ?? costField(raw, 'estimated_cost_usd') ?? null;
    return {
      sessionCount: Math.max(0, Math.floor(raw.sessions)),
      tokens: Math.max(0, input + output),
      costUsd: cost,
    };
  }
  // One Session's counters always carry the counter keys — the Gate's
  // `usageOf` emits every one even when zero — so a record with none of
  // them is not a usage read (an id alone carries no spend to render) and
  // falls back to today's title-and-Raw instead of a zeroed spend line.
  const hasCounters =
    numberField(raw, 'input_tokens') !== undefined ||
    numberField(raw, 'output_tokens') !== undefined ||
    costField(raw, 'actual_cost_usd') !== undefined ||
    costField(raw, 'estimated_cost_usd') !== undefined;
  if (!hasCounters) return null;
  const usage = sessionUsage({
    input_tokens: numberField(raw, 'input_tokens'),
    output_tokens: numberField(raw, 'output_tokens'),
    actual_cost_usd: costField(raw, 'actual_cost_usd'),
    estimated_cost_usd: costField(raw, 'estimated_cost_usd'),
  });
  return { sessionCount: 1, tokens: usage.tokens, costUsd: usage.costUsd };
}

export function applySessionSpendRead(
  previous: SessionSpendState,
  read: SessionSpendRead,
): SessionSpendState {
  if (read.ok) {
    return { sessions: read.sessions, rowCount: read.rowCount, loaded: true, failed: false };
  }
  // The retained last-good list keeps the row count it was read at: the bound
  // line describes that list, not the read that failed.
  if (previous.loaded) {
    return {
      sessions: previous.sessions,
      rowCount: previous.rowCount,
      loaded: true,
      failed: true,
    };
  }
  return { sessions: [], rowCount: 0, loaded: false, failed: true };
}

/** This open thread's tokens and cost — not the total of every session. */
export function threadUsage(
  sessions: SessionUsageInput[],
  sessionId: string | undefined,
): SessionUsage | undefined {
  const wanted = sessionId?.trim();
  if (!wanted) return undefined;
  const match = sessions.find((session) => session.id === wanted);
  return match ? sessionUsage(match) : undefined;
}

export function threadSpendCopy(
  state: SessionSpendState,
  sessionId: string | undefined,
): string | undefined {
  if (!state.loaded && state.failed) return 'Spend could not be read.';
  if (!state.loaded) return undefined;
  const usage = threadUsage(state.sessions, sessionId);
  if (!usage) {
    return state.failed ? 'Could not re-read spend — showing the last total.' : undefined;
  }
  return `${formatTokenCount(usage.tokens)} · ${usage.costUsd == null ? '—' : formatCost(usage.costUsd)}`;
}

/**
 * Overflow spend is the glance fold. A missing selector list is not a miss:
 * unread and empty-ok stay silent. A failed read is named. Never tells the
 * operator to open Sessions.
 */
export function overflowSpendCopy(
  state: SessionSpendState,
  sessionId: string | undefined,
): string | undefined {
  return threadSpendCopy(state, sessionId);
}

/** This thread's usage row for overflow meters — input and output stay separate. */
export function overflowSpendSession(
  state: SessionSpendState,
  sessionId: string | undefined,
): SessionUsageInput | undefined {
  if (!state.loaded) return undefined;
  const wanted = sessionId?.trim();
  if (!wanted) return undefined;
  return state.sessions.find((session) => session.id === wanted);
}

/**
 * Effect identity for the open-thread spend glance. Surface and session
 * changes already re-read. A live send is a different key than idle, so the
 * glance also re-reads when the turn finishes.
 */
export function threadSpendRefreshKey(input: {
  surfaceKey: string | undefined;
  sessionId: string | undefined;
  sending: boolean;
}): string | undefined {
  if (!input.surfaceKey) return undefined;
  const session = input.sessionId?.trim() ?? '';
  return `${input.surfaceKey}:${session}:${input.sending ? 'sending' : 'idle'}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionItems(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return null;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.sessions)) return raw.sessions;
  if (Array.isArray(raw.items)) return raw.items;
  return null;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function sessionIdentity(record: Record<string, unknown>): string | undefined {
  return stringField(record, 'id') ?? stringField(record, 'sessionId') ?? stringField(record, 'name');
}

function costField(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function asUsageInput(raw: unknown): SessionUsageInput | null {
  if (!isRecord(raw)) return null;
  const input: SessionUsageInput = {};
  const id = sessionIdentity(raw);
  const inputTokens = numberField(raw, 'input_tokens');
  const outputTokens = numberField(raw, 'output_tokens');
  const actual = costField(raw, 'actual_cost_usd');
  const estimated = costField(raw, 'estimated_cost_usd');
  const lastActive = numberField(raw, 'last_active');
  if (id !== undefined) input.id = id;
  if (inputTokens !== undefined) input.input_tokens = inputTokens;
  if (outputTokens !== undefined) input.output_tokens = outputTokens;
  if (actual !== undefined) input.actual_cost_usd = actual;
  if (estimated !== undefined) input.estimated_cost_usd = estimated;
  if (lastActive !== undefined) input.last_active = lastActive;
  return input;
}

/**
 * How many sessions.list rows the spend folds read. The Gate's own wide
 * catalogue read totals 200 rows (`session.usage` lists 200 in
 * `gate/core/capabilities/gateway-methods.mjs`), and the thread selector
 * can widen to the same 200 (`SESSION_LIST_MAX` in session-list.ts), so
 * the glance covers every thread the roster can open instead of silently
 * stopping at 50.
 */
export const SESSION_SPEND_LIST_LIMIT = 200;

/**
 * Honest window line for the 7-day sparkline. A filled window may be
 * truncated — the list endpoint takes `limit` but no cursor — so a full
 * read names its bound instead of reading as the whole catalogue. Callers
 * pass the read's ROW count (`SessionSpendRead.rowCount`), not the sessions
 * that parsed, or a capped read that dropped an unparseable row would name
 * no bound at all. A partial or unreadable count stays on the old
 * recent-sessions line.
 */
export function spendWindowCopy(sessionCount: number): string {
  if (Number.isFinite(sessionCount) && sessionCount >= SESSION_SPEND_LIST_LIMIT) {
    return `Last 7 days · newest ${SESSION_SPEND_LIST_LIMIT} sessions`;
  }
  return 'Last 7 days · recent sessions';
}

/**
 * Honest bound line for the gateway total.
 *
 * The total is folded from the whole catalogue read (`totalUsage`), not from
 * a window: nothing filters it by age, so a session older than seven days is
 * inside the number and `spendWindowCopy` — whose "Last 7 days" is literal —
 * cannot caption it. That line belongs to the 7-day chart, which is the
 * surface actually read over `weekBuckets`. What the total can name is the
 * bound its read stopped at: the list endpoint takes `limit` but no cursor, so
 * a filled read is capped and a partial one is everything this device could
 * see. Callers pass the read's ROW count (`SessionSpendRead.rowCount`), not
 * the sessions that parsed, so a capped read that dropped an unparseable row
 * still names its cap — and an unreadable count prints no number rather than
 * "NaN".
 */
export function spendTotalBoundCopy(sessionCount: number): string {
  const rows = Number.isFinite(sessionCount) ? Math.max(0, Math.floor(sessionCount)) : 0;
  if (rows >= SESSION_SPEND_LIST_LIMIT) {
    return `Across the newest ${SESSION_SPEND_LIST_LIMIT} sessions — older sessions are past the list's cap`;
  }
  return `Across the ${rows} sessions in this read`;
}

/**
 * Parse a sessions.list payload into the fields sessionUsage already reads.
 * Gate answers `{ object: 'list', data }`; Hermes `/api/sessions` is the
 * same envelope; a raw array is also a list. Anything else is a failed
 * read — never zero spend.
 *
 * `rowCount` is the rows the payload held, which is what a bound line reads:
 * a row with nothing to parse is dropped from `sessions` — it carries no
 * spend — but it was still a row of the window the endpoint returned.
 */
export function sessionSpendReadFromUnknown(raw: unknown): SessionSpendRead {
  const items = sessionItems(raw);
  if (!items) return { ok: false };
  const sessions: SessionUsageInput[] = [];
  for (const item of items) {
    const session = asUsageInput(item);
    if (session) sessions.push(session);
  }
  return { ok: true, sessions, rowCount: items.length };
}

export function relativeMeter(value: number, weekMax: number): RelativeMeter {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const safeWeek = Number.isFinite(weekMax) ? Math.max(0, weekMax) : 0;
  const peak = Math.max(safeValue, safeWeek, 0);
  return { value: safeValue, peak, ratio: peak === 0 ? 0 : safeValue / peak };
}

export function weekBuckets(sessions: SessionUsageInput[], now: number): WeekBucket[] {
  const today = startOfLocalDay(now);
  const buckets: WeekBucket[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const cursor = new Date(today);
    cursor.setDate(cursor.getDate() - offset);
    buckets.push({ startMs: cursor.getTime(), tokens: 0, costUsd: 0 });
  }
  const indexByStart = new Map(buckets.map((bucket, index) => [bucket.startMs, index]));
  for (const session of sessions) {
    if (typeof session.last_active !== 'number' || !Number.isFinite(session.last_active)) continue;
    const start = startOfLocalDay(toEpochMs(session.last_active));
    const index = indexByStart.get(start);
    if (index === undefined) continue;
    const usage = sessionUsage(session);
    buckets[index].tokens += usage.tokens;
    buckets[index].costUsd += usage.costUsd ?? 0;
  }
  return buckets;
}

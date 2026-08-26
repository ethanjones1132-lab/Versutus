import { formatCost, formatTokenCount } from '@/lib/format';

export type SessionUsageInput = {
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
  | { ok: true; sessions: SessionUsageInput[] }
  | { ok: false };

export type WeekBucket = { startMs: number; tokens: number; costUsd: number };

export type RelativeMeter = { value: number; peak: number; ratio: number };

function toEpochMs(timestamp: number): number {
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function startOfLocalDay(ms: number): number {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

export function sessionUsage(session: SessionUsageInput): SessionUsage {
  const input = typeof session.input_tokens === 'number' ? session.input_tokens : 0;
  const output = typeof session.output_tokens === 'number' ? session.output_tokens : 0;
  const tokens = Math.max(0, input + output);
  const cost = session.actual_cost_usd ?? session.estimated_cost_usd;
  return { tokens, costUsd: typeof cost === 'number' ? cost : null };
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

function costField(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function asUsageInput(raw: unknown): SessionUsageInput | null {
  if (!isRecord(raw)) return null;
  const input: SessionUsageInput = {};
  const inputTokens = numberField(raw, 'input_tokens');
  const outputTokens = numberField(raw, 'output_tokens');
  const actual = costField(raw, 'actual_cost_usd');
  const estimated = costField(raw, 'estimated_cost_usd');
  const lastActive = numberField(raw, 'last_active');
  if (inputTokens !== undefined) input.input_tokens = inputTokens;
  if (outputTokens !== undefined) input.output_tokens = outputTokens;
  if (actual !== undefined) input.actual_cost_usd = actual;
  if (estimated !== undefined) input.estimated_cost_usd = estimated;
  if (lastActive !== undefined) input.last_active = lastActive;
  return input;
}

/**
 * Parse a sessions.list payload into the fields sessionUsage already reads.
 * Gate answers `{ object: 'list', data }`; Hermes `/api/sessions` is the
 * same envelope; a raw array is also a list. Anything else is a failed
 * read — never zero spend.
 */
export function sessionSpendReadFromUnknown(raw: unknown): SessionSpendRead {
  const items = sessionItems(raw);
  if (!items) return { ok: false };
  const sessions: SessionUsageInput[] = [];
  for (const item of items) {
    const session = asUsageInput(item);
    if (session) sessions.push(session);
  }
  return { ok: true, sessions };
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

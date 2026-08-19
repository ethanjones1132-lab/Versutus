export type SessionUsageInput = {
  input_tokens?: number;
  output_tokens?: number;
  actual_cost_usd?: number | null;
  estimated_cost_usd?: number | null;
  last_active?: number;
};

export type SessionUsage = { tokens: number; costUsd: number | null };

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

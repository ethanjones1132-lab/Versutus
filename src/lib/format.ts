/** Small display formatters shared across chat, home, and activity surfaces. */

/** 1200 → "1.2k", 2500000 → "2.5M" */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** 0.0042 → "$0.0042", 1.2 → "$1.20" */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$0.00';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Relative timestamp: "just now", "4m ago", "2h ago", "3d ago", else short date. */
export function formatRelativeTime(timestamp: number): string {
  const ms = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const delta = Date.now() - ms;
  if (delta < 45_000) return 'just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Compact clock time for message details: "14:03" */
export function formatClockTime(timestamp: number): string {
  const ms = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Day-group label for message dividers: "Today", "Yesterday", weekday, else short date.
 * `now` defaults to the current time and is only overridden in tests for determinism.
 */
export function formatDayDivider(timestamp: number, now: number = Date.now()): string {
  const ms = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const day = new Date(ms);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOf(new Date(now)) - startOf(day)) / 86_400_000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return day.toLocaleDateString(undefined, { weekday: 'long' });
  return day.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: day.getFullYear() !== new Date(now).getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Day-group labels depend only on the message's calendar day and the *current*
 * calendar day (Today / Yesterday / weekday / date). The transcript rebuilds its
 * item array on every coalesced streamed frame, so without caching a 200-message
 * thread re-runs `toLocaleDateString` ~400 times per frame. Labels within the same
 * day are computed once and reused; the cache is dropped when the current calendar
 * day rolls over (the only event that can change a label).
 */
let dayDividerCache: { currentDayStart: number; entries: Map<number, string> } | null = null;

function startOfDayKey(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatDayDividerCached(timestamp: number, now: number = Date.now()): string {
  const ms = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const dayStart = startOfDayKey(ms);
  const currentDayStart = startOfDayKey(now);
  if (!dayDividerCache || dayDividerCache.currentDayStart !== currentDayStart) {
    dayDividerCache = { currentDayStart, entries: new Map() };
  }
  const cached = dayDividerCache.entries.get(dayStart);
  if (cached !== undefined) return cached;
  const label = formatDayDivider(timestamp, now);
  dayDividerCache.entries.set(dayStart, label);
  return label;
}

/** Connected-ceremony HUD: "Connected · Studio · v0.5.2" */
export function formatConnectedToastLabel(input: {
  gatewayName?: string | null;
  version?: string | null;
}): string {
  const parts = ['Connected'];
  if (input.gatewayName) parts.push(input.gatewayName);
  if (input.version) parts.push(`v${input.version}`);
  return parts.join(' \u00b7 ');
}

/** Elapsed duration: "0:07", "3:42", "1:02:11" */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

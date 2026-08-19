// ─── Frequency-with-decay ranking for recent commands ─────────────
// A pure MRU list forgets that you run /status ten times a day the moment you
// run anything else once. Pure frequency has the opposite failure: a command
// you hammered last month outranks the one you are using right now. This
// scores each command by how often it was used, decayed by how long ago.

export type CommandUsage = {
  command: string;
  count: number;
  /** Epoch ms of the most recent use. */
  lastUsedAt: number;
};

/**
 * A use is worth half as much after this long. One week keeps "what I ran today"
 * ahead of "what I ran a lot in a burst last month", without discarding a
 * genuinely habitual command after a quiet weekend.
 */
export const USAGE_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap on tracked commands, so storage cannot grow without bound. */
export const USAGE_ENTRY_CAP = 40;

/**
 * Decayed frequency. Decay is applied to the whole count using the age of the
 * last use — an approximation, since individual use timestamps are not kept,
 * but one that behaves correctly at both ends: a high count used recently wins,
 * and any count decays toward zero once it goes untouched.
 */
export function scoreUsage(entry: CommandUsage, now: number): number {
  const age = Math.max(0, now - entry.lastUsedAt);
  return entry.count * Math.pow(0.5, age / USAGE_HALF_LIFE_MS);
}

/** Record one use, returning a new list. Unknown commands start at count 1. */
export function recordUsage(
  usage: readonly CommandUsage[],
  command: string,
  now: number,
): CommandUsage[] {
  const trimmed = command.trim();
  if (!trimmed) return [...usage];

  let found = false;
  const next = usage.map((entry) => {
    if (entry.command !== trimmed) return entry;
    found = true;
    return { ...entry, count: entry.count + 1, lastUsedAt: now };
  });

  if (!found) next.push({ command: trimmed, count: 1, lastUsedAt: now });

  // Evict the lowest-scoring entries rather than the oldest: a rarely-used
  // command added yesterday is a better eviction candidate than a daily driver
  // that happens not to have been run in the last hour.
  if (next.length > USAGE_ENTRY_CAP) {
    return [...next].sort((a, b) => scoreUsage(b, now) - scoreUsage(a, now)).slice(0, USAGE_ENTRY_CAP);
  }
  return next;
}

/**
 * Rank commands best-first. Ties break on recency, then on command text so the
 * order is stable across runs rather than dependent on insertion order.
 */
export function rankCommands(usage: readonly CommandUsage[], now: number, limit?: number): string[] {
  const ranked = [...usage].sort((a, b) => {
    const diff = scoreUsage(b, now) - scoreUsage(a, now);
    if (Math.abs(diff) > 1e-9) return diff;
    if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    return a.command.localeCompare(b.command);
  });

  const commands = ranked.map((entry) => entry.command);
  return typeof limit === 'number' ? commands.slice(0, limit) : commands;
}

/**
 * Read persisted usage, accepting the legacy shape.
 *
 * Recents were previously a plain `string[]` MRU. Those entries are migrated as
 * count 1, with synthetic timestamps that preserve their existing order — so an
 * upgrade does not reset what the user has built up, and does not pretend the
 * old list carried frequency data it never had.
 */
export function parseStoredUsage(raw: unknown, now: number): CommandUsage[] {
  if (!Array.isArray(raw)) return [];

  if (raw.every((item) => typeof item === 'string')) {
    return (raw as string[]).map((command, index) => ({
      command,
      count: 1,
      // Index 0 is most recent in the legacy MRU; space them a second apart.
      lastUsedAt: now - index * 1000,
    }));
  }

  return raw.flatMap((item): CommandUsage[] => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Partial<CommandUsage>;
    if (typeof entry.command !== 'string' || !entry.command) return [];
    return [
      {
        command: entry.command,
        count: typeof entry.count === 'number' && entry.count > 0 ? entry.count : 1,
        lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : now,
      },
    ];
  });
}

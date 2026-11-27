// ─── The local store for per-turn change records ───────────────────
// VS-094, slice 2: records survive the turn, and nothing else does.
//
// The store is the only persistence seam. It takes an injected adapter (the
// app passes `keyValueStorage`; a test passes a Map), applies the landed caps,
// serialises through the pure whitelist, and keeps the journal's horizon:
// records older than 7 days, or beyond the 300 most recently used turns, are
// evicted least-recently-used first.
//
// A record that is missing, corrupt, schema-mismatched or stored under the
// wrong turn degrades to `null`. `null` means "Changes are unavailable for this
// turn" — never an empty list standing in for a guess.

import type { TurnChangeCaps, TurnChangeRecord } from '@/lib/chat/turn-changes';
import {
  capTurnChanges,
  parseTurnChangeRecord,
  serializeTurnChangeRecord,
} from '@/lib/chat/turn-changes';

/** The journal keeps a turn for 7 days; the local store follows it. */
export const TURN_CHANGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The journal keeps 300 turns; beyond that the store evicts by use. */
export const TURN_CHANGE_MAX_TURNS = 300;

export const TURN_CHANGE_RECORD_PREFIX = 'turn-change-record:v1:';
export const TURN_CHANGE_INDEX_KEY = 'turn-change-index:v1';

/** The storage key for one turn's record. Exported for cleanup and tests. */
export function turnChangeRecordKey(turnId: string): string {
  return `${TURN_CHANGE_RECORD_PREFIX}${encodeURIComponent(turnId)}`;
}

/**
 * The adapter the store needs. `keyValueStorage` already matches it, and
 * `getAllKeys` is optional: without it the index still drives eviction, but a
 * lost index cannot be repaired by scanning.
 */
export type TurnChangeStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys?(): Promise<string[]>;
};

export type TurnChangeStoreOptions = {
  storage: TurnChangeStorage;
  /** Clock seam, so the horizon is testable. Defaults to `Date.now`. */
  now?: () => number;
  /** Overridable only for tests and small stores; defaults to the design cap. */
  ttlMs?: number;
  maxTurns?: number;
  /** Caps applied on save; defaults to the landed 200 paths / 32 KB. */
  caps?: TurnChangeCaps;
};

export type TurnChangeStore = {
  /** Cap, serialise and persist one record. Returns what was stored. */
  save(record: TurnChangeRecord): Promise<TurnChangeRecord>;
  /** One turn's record, or `null` when it is missing, corrupt or expired. */
  load(turnId: string): Promise<TurnChangeRecord | null>;
  remove(turnId: string): Promise<void>;
  /** Drop expired records and evict beyond `maxTurns`. Returns how many went. */
  prune(): Promise<number>;
};

type IndexEntry = {
  turnId: string;
  savedAt: number;
  usedAt: number;
  endedAt: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asIndexEntry(value: unknown): IndexEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.turnId !== 'string' || !entry.turnId) return null;
  if (!isFiniteNumber(entry.savedAt) || !isFiniteNumber(entry.usedAt)) return null;
  if (!isFiniteNumber(entry.endedAt)) return null;
  return {
    turnId: entry.turnId,
    savedAt: entry.savedAt,
    usedAt: entry.usedAt,
    endedAt: entry.endedAt,
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Create a store over an injected adapter.
 *
 * The index is a small JSON row list kept beside the records. A corrupt index
 * is rebuilt from the record keys when the adapter can list them, so index
 * damage costs a scan rather than the stored records.
 */
export function createTurnChangeStore(options: TurnChangeStoreOptions): TurnChangeStore {
  const storage = options.storage;
  const clock = options.now ?? Date.now;
  const ttlMs = isFiniteNumber(options.ttlMs) && options.ttlMs >= 0
    ? options.ttlMs
    : TURN_CHANGE_TTL_MS;
  const maxTurns = isFiniteNumber(options.maxTurns) && options.maxTurns >= 0
    ? Math.floor(options.maxTurns)
    : TURN_CHANGE_MAX_TURNS;

  /** The index as stored, `null` when it exists but cannot be trusted. */
  async function readIndex(): Promise<IndexEntry[] | null> {
    let raw: string | null = null;
    try {
      raw = await storage.getItem(TURN_CHANGE_INDEX_KEY);
    } catch {
      return null;
    }
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const entries: IndexEntry[] = [];
      for (const row of parsed) {
        const entry = asIndexEntry(row);
        // One malformed row makes the whole index untrustworthy: keeping the
        // rest would silently drop the unnamed records from eviction.
        if (!entry) return null;
        entries.push(entry);
      }
      return entries;
    } catch {
      return null;
    }
  }

  /** Every stored key, when the adapter can list them; `null` when it cannot. */
  async function listKeys(): Promise<string[] | null> {
    const getAllKeys = storage.getAllKeys;
    if (!getAllKeys) return null;
    try {
      return await getAllKeys.call(storage);
    } catch {
      return null;
    }
  }

  /**
   * Rebuild the index from the record keys on disk, when the adapter can list.
   * A corrupt index therefore costs a scan, never the stored records.
   */
  async function rebuildIndex(now: number): Promise<IndexEntry[]> {
    const keys = await listKeys();
    if (!keys) return [];
    const entries: IndexEntry[] = [];
    for (const key of keys) {
      if (!key.startsWith(TURN_CHANGE_RECORD_PREFIX)) continue;
      let raw: string | null = null;
      try {
        raw = await storage.getItem(key);
      } catch {
        continue;
      }
      const record = parseTurnChangeRecord(raw);
      if (!record) {
        // A corrupt record is unrecoverable; it must not survive the horizon
        // as an unreadable row either.
        try {
          await storage.removeItem(key);
        } catch {
          // Best effort.
        }
        continue;
      }
      entries.push({ turnId: record.turnId, savedAt: now, usedAt: now, endedAt: record.endedAt });
    }
    return entries;
  }

  /** The index, rebuilt once when it was corrupt or lost. */
  async function readIndexSafe(now: number): Promise<IndexEntry[]> {
    const entries = await readIndex();
    if (entries !== null) {
      if (entries.length > 0) return entries;
      // An empty index with record keys on disk is a lost index, not an empty
      // store: recover the rows instead of letting the scan delete them.
      const keys = await listKeys();
      if (keys?.some((key) => key.startsWith(TURN_CHANGE_RECORD_PREFIX))) {
        return rebuildIndex(now);
      }
      return entries;
    }
    return rebuildIndex(now);
  }

  async function writeIndex(entries: IndexEntry[]): Promise<void> {
    await storage.setItem(TURN_CHANGE_INDEX_KEY, JSON.stringify(entries));
  }

  async function removeRecord(turnId: string): Promise<void> {
    try {
      await storage.removeItem(turnChangeRecordKey(turnId));
    } catch {
      // A delete the adapter refused leaves an unreachable row, not a wrong one.
    }
  }

  /** Forget one turn: the record and its LRU row, so a dead entry cannot evict a live one. */
  async function forget(turnId: string, now: number): Promise<void> {
    await removeRecord(turnId);
    try {
      const entries = await readIndexSafe(now);
      await writeIndex(entries.filter((entry) => entry.turnId !== turnId));
    } catch {
      // The record is gone; a stale index row will be pruned by use.
    }
  }

  /** Touch an entry so LRU tells "read recently" from "written recently". */
  async function touch(turnId: string, endedAt: number, now: number): Promise<void> {
    try {
      const entries = await readIndexSafe(now);
      const at = entries.findIndex((entry) => entry.turnId === turnId);
      if (at >= 0) {
        entries[at] = { ...entries[at], usedAt: now };
      } else {
        entries.push({ turnId, savedAt: now, usedAt: now, endedAt });
      }
      await writeIndex(entries);
    } catch {
      // A read must not fail because the LRU clock could not be written.
    }
  }

  async function pruneInternal(now: number): Promise<number> {
    const entries = await readIndexSafe(now);
    const kept: IndexEntry[] = [];
    let removed = 0;

    for (const entry of entries) {
      if (ttlMs >= 0 && now - entry.endedAt > ttlMs) {
        await removeRecord(entry.turnId);
        removed += 1;
        continue;
      }
      kept.push(entry);
    }

    if (kept.length > maxTurns) {
      kept.sort(
        (a, b) =>
          a.usedAt - b.usedAt
          || a.savedAt - b.savedAt
          || compareText(a.turnId, b.turnId),
      );
      while (kept.length > maxTurns) {
        const evicted = kept.shift();
        if (!evicted) break;
        await removeRecord(evicted.turnId);
        removed += 1;
      }
    }

    await writeIndex(kept);

    // A lost index must not orphan records past the horizon. When the adapter
    // can list keys, anything the index no longer names is removed.
    const keys = await listKeys();
    if (keys) {
      const live = new Set(kept.map((entry) => turnChangeRecordKey(entry.turnId)));
      for (const key of keys) {
        if (!key.startsWith(TURN_CHANGE_RECORD_PREFIX) || live.has(key)) continue;
        try {
          await storage.removeItem(key);
          removed += 1;
        } catch {
          // Best effort, as above.
        }
      }
    }

    return removed;
  }

  return {
    async save(record: TurnChangeRecord): Promise<TurnChangeRecord> {
      const turnId = typeof record.turnId === 'string' ? record.turnId : '';
      if (!turnId) throw new Error('A turn change record needs a turnId.');
      const capped = capTurnChanges(record, options.caps);
      // Serialise through the whitelist: content, patch, detail and output
      // cannot reach the adapter even if a caller bolted them on. Parse it back
      // so the returned value is exactly the stored shape, not a dirtier one.
      const serialized = serializeTurnChangeRecord(capped);
      const stored = parseTurnChangeRecord(serialized);
      if (!stored) throw new Error('A turn change record could not be serialised.');
      await storage.setItem(turnChangeRecordKey(turnId), serialized);

      const now = clock();
      const entries = (await readIndexSafe(now)).filter((entry) => entry.turnId !== turnId);
      entries.push({
        turnId,
        savedAt: now,
        usedAt: now,
        endedAt: stored.endedAt,
      });
      await writeIndex(entries);
      await pruneInternal(now);
      return stored;
    },

    async load(turnId: string): Promise<TurnChangeRecord | null> {
      if (!turnId) return null;
      let raw: string | null = null;
      try {
        raw = await storage.getItem(turnChangeRecordKey(turnId));
      } catch {
        return null;
      }
      if (!raw) return null;

      const record = parseTurnChangeRecord(raw);
      // A record stored under the wrong turn is a corrupt record: refuse it
      // rather than show one turn another turn's files.
      if (!record || record.turnId !== turnId) {
        await forget(turnId, clock());
        return null;
      }

      const now = clock();
      if (ttlMs >= 0 && now - record.endedAt > ttlMs) {
        await forget(turnId, now);
        return null;
      }

      await touch(turnId, record.endedAt, now);
      return record;
    },

    async remove(turnId: string): Promise<void> {
      if (!turnId) return;
      await forget(turnId, clock());
    },

    async prune(): Promise<number> {
      return pruneInternal(clock());
    },
  };
}

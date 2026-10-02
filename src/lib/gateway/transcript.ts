import { keyValueStorage } from '@/lib/storage/key-value';
import type { CommandTranscriptEntry } from '@/lib/gateway/types';

const TRANSCRIPT_PREFIX = 'versutus:transcript';

/**
 * How long a transcript write waits for the rest of the burst. The provider
 * calls `updateTranscript` on every streamed `/agent` delta, so writing through
 * each one costs a read, a parse and a serialize of the whole list at the token
 * rate. One write per quiet gap holds the same value far more cheaply.
 */
const TRANSCRIPT_FLUSH_MS = 250;

function transcriptKey(gatewayId: string, sessionKey: string): string {
  // Normalize sessionKey for storage key safety
  const safeSession = sessionKey.replace(/[:/\\]/g, '_');
  return `${TRANSCRIPT_PREFIX}:${gatewayId}:${safeSession}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── One queue and one in-memory copy per storage key ─────────────
// `appendTranscript` and `updateTranscript` are read-modify-write over a single
// AsyncStorage key. Unserialized, two overlapping calls each build their list
// from the same snapshot and the later write erases the earlier one's summary —
// the same hazard `storage.ts` and `session-persistence.ts` already queue
// against. Each key gets its own promise chain, so a mutation reads what the
// previous one wrote without putting unrelated keys behind each other, and a
// failed task rejects its own caller without poisoning the queue.
const mutationTails = new Map<string, Promise<void>>();

// How many mutations are still queued or running for a key. A held copy must
// not be evicted while one is in flight: the queued task reads it back, so
// dropping it would lose the delta the write was about to persist.
const busyKeys = new Map<string, number>();

function markKeyBusy(key: string): void {
  busyKeys.set(key, (busyKeys.get(key) ?? 0) + 1);
}

function releaseKeyBusy(key: string): void {
  const remaining = (busyKeys.get(key) ?? 0) - 1;
  if (remaining > 0) busyKeys.set(key, remaining);
  else busyKeys.delete(key);
}

function enqueueTranscriptMutation<T>(key: string, task: () => Promise<T>): Promise<T> {
  markKeyBusy(key);
  const result = (mutationTails.get(key) ?? Promise.resolve()).then(task);
  mutationTails.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  void result.then(
    () => releaseKeyBusy(key),
    () => releaseKeyBusy(key),
  );
  return result;
}

// The entries this process holds for a key, whether or not the write behind
// them has landed. A load fills it; every mutation replaces it. It is what lets
// a burst of updates cost one write and what lets a read see an update that is
// still queued.
const entriesByKey = new Map<string, CommandTranscriptEntry[]>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How many session transcripts this process keeps in memory. Each held copy is
 * a full parsed list (up to 200 entries, each with its `raw`), and
 * `loadTranscripts` runs on every thread switch, so an install that walks the
 * Sessions sheet would otherwise retain one per visited thread for its whole
 * lifetime. A small ring bounds that: the thread on screen plus recent ones
 * stay hot, and a re-visit costs one storage read, never a lost write.
 */
const MAX_HELD_TRANSCRIPTS = 16;

/**
 * Hold a key's entries and evict the oldest if the ring is over budget. A key
 * with a pending debounced write or an in-flight mutation is skipped — its held
 * copy is what that write reads, so dropping it would lose the delta. Map
 * insertion order is the age order (`loadTranscripts` re-inserts a hit).
 */
function holdEntries(key: string, entries: CommandTranscriptEntry[]): void {
  entriesByKey.set(key, entries);
  if (entriesByKey.size <= MAX_HELD_TRANSCRIPTS) return;
  for (const candidate of [...entriesByKey.keys()]) {
    if (entriesByKey.size <= MAX_HELD_TRANSCRIPTS) break;
    if (flushTimers.has(candidate) || busyKeys.has(candidate)) continue;
    entriesByKey.delete(candidate);
    mutationTails.delete(candidate);
  }
}
// Every write still owed to the store, so `flushTranscripts` can join the ones
// its forced flush just enqueued.
const pendingWrites = new Set<Promise<void>>();

function trackWrite(write: Promise<void>): void {
  pendingWrites.add(write);
  // A debounced write has no caller to reject to, so its failure is held here
  // and handed to whoever forces the next flush. The tail always settles
  // resolved so the set drains even when the write did not.
  void write.then(
    () => pendingWrites.delete(write),
    () => pendingWrites.delete(write),
  );
}

function cancelFlush(key: string): void {
  const timer = flushTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  flushTimers.delete(key);
}

function enqueueWrite(key: string): void {
  const write = enqueueTranscriptMutation(key, async () => {
    const entries = entriesByKey.get(key);
    // The key was cleared while this write waited its turn; there is nothing of
    // its left to put.
    if (!entries) return;
    await keyValueStorage.setItem(key, JSON.stringify(entries));
  });
  trackWrite(write);
}

function scheduleFlush(key: string): void {
  // Trailing: a burst keeps pushing the write out, and the value written is
  // whatever the key holds when the gap finally arrives.
  cancelFlush(key);
  flushTimers.set(
    key,
    setTimeout(() => {
      flushTimers.delete(key);
      enqueueWrite(key);
    }, TRANSCRIPT_FLUSH_MS),
  );
}

/**
 * Write every transcript this process is still holding. A backgrounded app and
 * a test both need the store to hold what the UI already shows, and neither
 * wants to wait out the debounce: the pending timers are forced now and their
 * writes joined as they are enqueued. A mutation whose task has not run yet is
 * not waited for — flush after the mutations it should cover.
 */
export async function flushTranscripts(): Promise<void> {
  for (const key of [...flushTimers.keys()]) {
    cancelFlush(key);
    enqueueWrite(key);
  }
  let failure: unknown;
  for (;;) {
    const writes = [...pendingWrites];
    if (writes.length === 0) break;
    const settled = await Promise.allSettled(writes);
    for (const outcome of settled) {
      if (outcome.status === 'rejected' && failure === undefined) failure = outcome.reason;
    }
  }
  // Reported only once every other owed write has had its turn: one refused
  // write does not hide the rest.
  if (failure !== undefined) throw failure;
}

async function readStoredEntries(key: string): Promise<CommandTranscriptEntry[]> {
  let raw: string | null;
  try {
    raw = await keyValueStorage.getItem(key);
  } catch (error) {
    // AsyncStorage can refuse a read (an Android row-size or SQLite fault). A
    // history reload that throws takes the session's transcript with it, so an
    // unreadable key reads as an empty one and says why.
    console.warn(`[transcript] Could not read "${key}": ${describeError(error)}`);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CommandTranscriptEntry[];
    if (!Array.isArray(parsed)) return [];
    holdEntries(key, parsed);
    return parsed;
  } catch {
    return [];
  }
}

export async function loadTranscripts(gatewayId: string, sessionKey: string): Promise<CommandTranscriptEntry[]> {
  const key = transcriptKey(gatewayId, sessionKey);
  // The held copy, not the stored one: a read that went back to storage while
  // an update was still queued would show the operator a transcript missing the
  // delta they are watching arrive.
  const held = entriesByKey.get(key);
  if (held) {
    // Refresh its place in the ring: the thread the operator is looking at must
    // be the last evicted, not the first.
    entriesByKey.delete(key);
    entriesByKey.set(key, held);
    return held;
  }
  return readStoredEntries(key);
}

export async function saveTranscripts(gatewayId: string, sessionKey: string, entries: CommandTranscriptEntry[]): Promise<void> {
  const key = transcriptKey(gatewayId, sessionKey);
  // Keep only the last N to avoid unbounded growth (plan implies bounded history)
  const limited = entries.slice(-200);
  holdEntries(key, limited);
  // A whole-list save is not a delta, so it writes through now instead of
  // waiting for a gap nobody is going to extend.
  cancelFlush(key);
  await enqueueTranscriptMutation(key, () => keyValueStorage.setItem(key, JSON.stringify(limited)));
}

async function mutateEntries(
  gatewayId: string,
  sessionKey: string,
  apply: (existing: CommandTranscriptEntry[]) => CommandTranscriptEntry[],
): Promise<CommandTranscriptEntry[]> {
  const key = transcriptKey(gatewayId, sessionKey);
  return enqueueTranscriptMutation(key, async () => {
    const existing = entriesByKey.get(key) ?? (await readStoredEntries(key));
    // The bound is applied here, so what a caller is handed is the list the
    // store will hold rather than a longer one it never sees again.
    const limited = apply(existing).slice(-200);
    holdEntries(key, limited);
    scheduleFlush(key);
    return limited;
  });
}

export async function appendTranscript(
  gatewayId: string,
  sessionKey: string,
  entry: CommandTranscriptEntry,
): Promise<CommandTranscriptEntry[]> {
  return mutateEntries(gatewayId, sessionKey, (existing) => [...existing, entry]);
}

export async function updateTranscript(
  gatewayId: string,
  sessionKey: string,
  id: string,
  patch: Partial<CommandTranscriptEntry>,
): Promise<CommandTranscriptEntry[]> {
  return mutateEntries(gatewayId, sessionKey, (existing) =>
    existing.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  );
}

/**
 * Drop every stored transcript belonging to a gateway. Called when its profile
 * is deleted — without this the keys outlive the gateway forever.
 */
export async function clearTranscriptsForGateway(gatewayId: string): Promise<void> {
  // Keys are `versutus:transcript:{gatewayId}:{sessionKey}`. Matching includes
  // the trailing separator so `gw-1` does not also clear `gw-10`.
  const prefix = `${TRANSCRIPT_PREFIX}:${gatewayId}:`;
  // Dropped by prefix, not by the keys storage holds: a transcript still
  // waiting on its write-behind flush is only in the held copy, and so is the
  // timer that would put it back seconds after the profile it belonged to is
  // gone.
  for (const key of [...entriesByKey.keys()]) {
    if (!key.startsWith(prefix)) continue;
    cancelFlush(key);
    entriesByKey.delete(key);
  }
  const keys = await keyValueStorage.getAllKeys();
  const owned = keys.filter((key) => key.startsWith(prefix));
  await keyValueStorage.multiRemove(owned);
}

export function createTranscriptId(prefix = 'cmd'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The Gate's own copy of a backend's session list.
 *
 * Measured on the operator's host 2026-10-01: Hermes keeps every session in one
 * SQLite `state.db` that had grown to 6.2 GB, so listing sessions through it
 * costs 3-38 s and fails outright when the query runs past the read bound.
 * Every screen that lists threads paid that on every open, and a cold read that
 * needs 38 s could never succeed because it was aborted at 30 s.
 *
 * So the Gate keeps its OWN window of the newest sessions per (backend, Bot)
 * and answers a read from it, refreshing in the background. Hermes is not
 * written to, its schema is not touched and `state.db` is never opened: this
 * file is a copy of what a list already returned, plus what the operator's own
 * create/rename/delete did through the Gate.
 *
 * Shape of one key's entry: `{ sessions, fetchedLimit, refreshedAt }`, where
 * `fetchedLimit` is the page size the last read asked the backend for — a
 * caller asking for more than that is asking for rows this copy cannot have,
 * and must wait for a real read rather than be handed a short list.
 *
 * Persistence is one JSON file per key under `<dir>`, written atomically and
 * debounced, so a burst of write-through upserts costs one write. Every write
 * path swallows its own failures: a Gate that cannot write this cache must still
 * serve sessions.
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonFile, writeFileAtomic } from './atomic-file.mjs';

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_KEYS = 64;
const DEFAULT_WRITE_DELAY_MS = 250;

/** The identity of one window: an environment, and a Bot within it. */
export function sessionIndexKey(backendId, botId) {
  return `${backendId ?? ''}|${botId ?? ''}`;
}

/**
 * The two halves of a key, back out again.
 *
 * The environment id is Gate-assigned and never contains the separator, so the
 * FIRST `|` splits the pair; a Bot id that happened to contain one is still
 * read whole rather than truncated, because a wrong Bot id resolves to
 * `unknown_bot` — a loud refusal instead of a silent misroute.
 */
export function parseSessionIndexKey(key) {
  const text = String(key ?? '');
  const at = text.indexOf('|');
  if (at === -1) return { backendId: text || undefined, botId: undefined };
  return { backendId: text.slice(0, at) || undefined, botId: text.slice(at + 1) || undefined };
}

/**
 * A readable, collision-free file name for a key. Both halves are caller-supplied
 * ids that reach the Gate over HTTP, so they are sanitised rather than trusted;
 * the digest keeps two keys that sanitise alike apart.
 */
function fileNameFor(key) {
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const digest = createHash('sha1').update(String(key)).digest('hex').slice(0, 8);
  return `${safe}-${digest}.json`;
}

/**
 * Fold a write-through row into the row the copy already holds.
 *
 * Field by field, and never with a missing one: a chat turn knows the id and
 * the time, not the transcript counts or the cost a live read measured. Letting
 * it overwrite the whole row would replace everything the copy knew with
 * `undefined` — which is how a session's title and message count disappeared
 * from the list the moment the operator sent something in it.
 */
function mergeRow(held, incoming) {
  const merged = { ...held };
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

/** What a stored file has to look like before the copy may be believed. */
function toEntry(value, maxRows) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.sessions)) return null;
  const fetchedLimit = Number(value.fetchedLimit);
  const refreshedAt = Number(value.refreshedAt);
  return {
    sessions: value.sessions.slice(0, maxRows).filter((row) => row && typeof row.id === 'string'),
    fetchedLimit: Number.isFinite(fetchedLimit) && fetchedLimit > 0 ? Math.floor(fetchedLimit) : 0,
    refreshedAt: Number.isFinite(refreshedAt) ? refreshedAt : 0,
  };
}

export function createSessionIndex({
  dir,
  now = Date.now,
  maxRows = DEFAULT_MAX_ROWS,
  maxKeys = DEFAULT_MAX_KEYS,
  writeDelayMs = DEFAULT_WRITE_DELAY_MS,
  // What a session the Gate has never read a row for is stored as. A write
  // through only knows the id and the time — everything else belongs to a read —
  // so the shape of a brand-new row is supplied here rather than invented (and
  // possibly invented wrongly) at each call site.
  rowTemplate,
  log = (line) => console.warn(line),
} = {}) {
  /** Live windows, least recently used first. */
  const entries = new Map();
  /** Keys whose first load from disk is in flight. */
  const loading = new Map();
  /** The one refresh in flight per key; a second caller joins it. */
  const inFlight = new Map();
  /** The one write-through in flight per key; a second one waits for it. */
  const mutating = new Map();
  /**
   * The refill now on the wire for a key, as the write-throughs it still owes.
   * Present only while that read is in flight: a write-through with no read to
   * race is already in the copy, so there is nothing to replay it into.
   */
  const collecting = new Map();
  /** Payloads waiting for the next write, keyed the same way. */
  const pending = new Map();
  let writeTimer = null;

  function fileFor(key) {
    return join(dir, fileNameFor(key));
  }

  function remember(key) {
    const entry = entries.get(key);
    if (entry) {
      // Re-insert so the Map's insertion order is the access order.
      entries.delete(key);
      entries.set(key, entry);
    }
    return entry;
  }

  /** Keep the memory bound; the files stay on disk for the next cold start. */
  function evictIfNeeded() {
    while (entries.size > maxKeys) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  }

  /**
   * Record that a key changed, with the payload as it is now.
   *
   * The payload is captured here rather than read at flush time because a burst
   * of upserts must coalesce into ONE write, and because an eviction between
   * the change and the write must not lose it.
   */
  function schedule(key) {
    const entry = entries.get(key);
    if (!entry) return;
    pending.set(key, {
      sessions: entry.sessions,
      fetchedLimit: entry.fetchedLimit,
      refreshedAt: entry.refreshedAt,
    });
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void writePending();
    }, writeDelayMs);
    // A pending write is never a reason for the Gate to stay alive.
    writeTimer.unref?.();
  }

  async function writePending() {
    const batch = [...pending.entries()];
    pending.clear();
    for (const [key, payload] of batch) {
      try {
        await mkdir(dir, { recursive: true });
        // writeFileAtomic lands a *.tmp sibling and renames it over the target,
        // so a reader (or a kill mid-write) sees the old file or the new one.
        await writeFileAtomic(fileFor(key), JSON.stringify(payload), { encoding: 'utf8' });
      } catch (error) {
        // The copy is a cache. A Gate that cannot write it must still answer
        // with what it holds, and the next refresh will try again.
        log(`session-index: could not persist ${key}: ${error?.message ?? error}`);
      }
    }
  }

  async function load(key) {
    if (loading.has(key)) return loading.get(key);
    const pendingLoad = (async () => {
      const { state, value } = await readJsonFile(fileFor(key));
      // A file that is not there is the normal first run. One that is there and
      // unreadable is NOT the same thing: it is treated as an empty window (the
      // next read refills it) rather than crashing a request over a bad byte.
      if (state === 'ok') {
        const entry = toEntry(value, maxRows);
        if (entry) return entry;
        log(`session-index: ignoring unusable file for ${key}`);
      } else if (state === 'corrupt') {
        log(`session-index: ignoring corrupt file for ${key}: ${value?.error?.message ?? 'unreadable'}`);
      }
      return null;
    })().finally(() => loading.delete(key));
    loading.set(key, pendingLoad);
    return pendingLoad;
  }

  /**
   * The key's window in memory, reading its file the first time it is asked for.
   *
   * Every read AND every write comes through here, and that is the whole point:
   * a mutator working on the in-memory map alone sees an empty key after a
   * restart. A delete would then be a no-op (the session keeps showing), and the
   * first chat turn would replace the persisted window with a one-row copy that
   * claims no window at all — so the next list falls back to the slow read it
   * was built to avoid.
   */
  async function live(key) {
    if (!entries.has(key)) {
      const entry = await load(key);
      // A refill that landed while the file was being read is newer than it.
      if (entry && !entries.has(key)) {
        entries.set(key, entry);
        evictIfNeeded();
      }
    }
    return remember(key) ?? null;
  }

  /**
   * Run one write-through alone on its key, and return its answer.
   *
   * A write-through reads the window and writes it back, and on a key this
   * process has never filled that read awaits the file load. Two of them issued
   * in the same tick therefore both build their rows from the same pre-write
   * entry, and the second write discards the first's row — a thread the operator
   * has just created or sent in, gone from the list for a stale window with
   * nothing reporting it. One at a time per key is the whole fix: the second
   * reads what the first wrote.
   *
   * Refills are deliberately not in this chain. A read is 3-38 s, and a turn
   * that had to wait for it would be a turn that had to wait for it.
   */
  function exclusive(key, work) {
    const running = mutating.get(key);
    const attempt = (running ? running.catch(() => undefined) : Promise.resolve())
      .then(work)
      .finally(() => {
        if (mutating.get(key) === attempt) mutating.delete(key);
      });
    mutating.set(key, attempt);
    return attempt;
  }

  /**
   * Remember a write-through for the refill already on the wire for that key.
   *
   * A refill's rows are the backend's snapshot, taken while the write-through
   * was happening: a thread the operator has just created is not in them, and a
   * session they have just deleted still is. Replacing the window with those
   * rows is how the copy loses it, and the list the phone draws is answered
   * from the copy. The replay is the write-through itself rather than a second
   * implementation of it, so the two cannot drift.
   */
  function note(key, writeThrough) {
    collecting.get(key)?.push(writeThrough);
  }

  const api = {
    /** The row cap the index keeps per key; a read may not ask for more. */
    maxRows,

    /**
     * The stored window, or null when this key has never been filled. Loads
     * the key's file once per index instance.
     */
    async get(key) {
      const entry = await live(key);
      if (!entry) return null;
      return {
        sessions: entry.sessions.slice(),
        fetchedLimit: entry.fetchedLimit,
        refreshedAt: entry.refreshedAt,
      };
    },

    /**
     * The keys whose window holds `sessionId`, most recently refreshed first.
     *
     * Answers "which environment and Bot was this id last read from?", which is
     * what a scope-less exact-id lookup needs: the id alone says nothing, and
     * asking the first attached environment instead found nothing on a Gate
     * where Hermes sorted second. Empty means nobody here has claimed the id,
     * so the caller is left to sweep.
     *
     * Live windows only, and deliberately: a window this Gate has never read
     * has never claimed to hold anything, and a key evicted from the memory
     * bound is on disk but unparsed.
     */
    async keysWithSession(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return [];
      const held = [];
      for (const [key, entry] of entries) {
        if (entry.sessions.some((row) => row.id === sessionId)) held.push({ key, refreshedAt: entry.refreshedAt });
      }
      return held.sort((a, b) => b.refreshedAt - a.refreshedAt).map((row) => row.key);
    },

    /**
     * Refill a key from the backend, at most one read per key at a time.
     *
     * Single-flight is the point: a screen that asks while a cold read is still
     * running joins that read instead of starting a second one, so a slow host
     * is asked once and every caller that wanted those rows gets them.
     *
     * A join counts only when it read at least the window the caller asked for.
     * A refill at 20 rows cannot answer a read that asked for 200: answering it
     * hands the caller a short page with nothing marking it short, the app
     * concludes there is nothing older, and a Bot Chat that IS there reads as
     * absent — so a bigger ask waits for the running read and then makes its
     * own.
     *
     * @param {(limit?: number) => Promise<object[]>} loader
     */
    refresh(key, loader, { limit } = {}) {
      const window = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
      const running = inFlight.get(key);
      if (running && window <= running.window) return running.promise;
      const attempt = (async () => {
        // Another read for this key is already on the wire; ask the backend once,
        // not twice at once, however different the two windows are.
        if (running) await running.promise.catch(() => undefined);
        // From here on, a write-through can be clobbered by the rows this read
        // is about to land, so it is remembered for that read to replay.
        const owed = [];
        collecting.set(key, owed);
        const sessions = await loader(window || undefined);
        const rows = (Array.isArray(sessions) ? sessions : []).slice(0, maxRows);
        const entry = { sessions: rows, fetchedLimit: window, refreshedAt: now() };
        entries.delete(key);
        entries.set(key, entry);
        evictIfNeeded();
        collecting.delete(key);
        // The operator's own create, turn and delete are what the read cannot
        // know: it left before they happened. They are applied over its rows
        // through the write-throughs themselves, so the copy answers with the
        // thread they are in rather than the one the backend had 38 s ago.
        for (const writeThrough of owed) await writeThrough();
        schedule(key);
        const filled = entries.get(key) ?? entry;
        return {
          sessions: filled.sessions.slice(),
          fetchedLimit: filled.fetchedLimit,
          refreshedAt: filled.refreshedAt,
        };
      })().finally(() => {
        // Only this attempt's own registration: a bigger window that chained
        // behind this one has already taken the key's place in the map. A read
        // that failed owes nothing — it never wrote over the copy.
        collecting.delete(key);
        if (inFlight.get(key)?.promise === attempt) inFlight.delete(key);
      });
      inFlight.set(key, { promise: attempt, window });
      return attempt;
    },

    /**
     * Record one session the operator's own action produced, newest first.
     *
     * A row already held is merged onto field by field, so an action that knew
     * two fields cannot wipe the twenty a read measured. A row the copy has
     * never seen is built from `rowTemplate`, so it carries the keys a live read
     * would have returned with honest empties — and still claims no window
     * (`fetchedLimit` 0), so a later read still goes to the backend for the real
     * thing rather than answering with what little is here.
     */
    async upsert(key, session) {
      if (!session || typeof session.id !== 'string' || !session.id) return;
      return exclusive(key, async () => {
        const current = (await live(key)) ?? { sessions: [], fetchedLimit: 0, refreshedAt: 0 };
        const rows = current.sessions.slice();
        const at = rows.findIndex((row) => row.id === session.id);
        const merged = at === -1
          ? { ...(rowTemplate ? rowTemplate(session.id) : {}), ...session }
          : mergeRow(rows[at], session);
        if (at !== -1) rows.splice(at, 1);
        // Always to the top: whatever the Gate's copy last knew, this session is
        // the most recent thing that happened to it.
        rows.unshift(merged);
        entries.set(key, { ...current, sessions: rows.slice(0, maxRows) });
        evictIfNeeded();
        note(key, () => api.upsert(key, session));
        schedule(key);
      });
    },

    /** Forget a session the operator deleted, under every window it may be in. */
    async remove(key, sessionId) {
      return exclusive(key, async () => {
        const current = await live(key);
        if (!current) return;
        const rows = current.sessions.filter((row) => row.id !== sessionId);
        if (rows.length === current.sessions.length) return;
        entries.set(key, { ...current, sessions: rows });
        note(key, () => api.remove(key, sessionId));
        schedule(key);
      });
    },

    /**
     * A retitled session keeps its place. `preview` falls back to the title
     * upstream, so it moves with it — otherwise the row would show the old
     * subject under the new name until the next live read.
     */
    async rename(key, sessionId, title) {
      return exclusive(key, async () => {
        const current = await live(key);
        if (!current) return;
        const at = current.sessions.findIndex((row) => row.id === sessionId);
        if (at === -1) return;
        const row = current.sessions[at];
        const next = current.sessions.slice();
        next.splice(at, 1, { ...row, title, preview: row.preview ?? title });
        entries.set(key, { ...current, sessions: next });
        note(key, () => api.rename(key, sessionId, title));
        schedule(key);
      });
    },

    /** Write the coalesced changes now (shutdown, or a test that wants them). */
    async flush() {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      await writePending();
    },
  };
  return api;
}

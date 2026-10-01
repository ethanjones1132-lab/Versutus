// ─── Which backend answers a spoken turn ────────────────────────────────
// A call carries the thread it was started from. A Bot names its environment;
// an explicit backendId pins one; an unscoped thread speaks to the chat path
// its typed turns use.
//
// Every spoken turn resolves again (server.mjs `runTurn` → `runVoiceTurn` →
// here), and resolving is not free: each candidate is `backendManager.get(id)`,
// which re-reads the record, re-resolves its credential bindings through the
// vault and, for an HTTP transport, re-validates a live health fetch. That
// latency lands in the time-to-first-token of every reply in a call, for an
// answer that cannot change between two turns of the same call. So the resolved
// backend is memoised per thread for a short lease.

/**
 * How long a resolved backend stays memoised. A lease, not a cache: a backend
 * can be replaced by an environment edit (a different adapter, new
 * credentials, the Bot moved to another environment), and the Gate must not
 * keep answering for the old one. Twenty seconds is far below the gap between
 * an operator editing an environment and the next thing they say, and far above
 * the gap between two turns of one call — where it removes every repeat.
 */
const VOICE_BACKEND_LEASE_MS = 20_000;

/** `backendManager` → thread key → `{ backend, expiresAt }`. A WeakMap so a
 *  manager that is replaced (a reloaded environment registry) takes its leases
 *  with it instead of handing them to whatever holds the key next. */
const leases = new WeakMap();

/** What the phone's thread selects: a Bot names an environment by owning it, an
 *  explicit backendId pins one, and neither means the unscoped chat path. Two
 *  threads that select identically resolve identically, so they share a lease —
 *  and the key is JSON-encoded so no id containing the separator can make two
 *  different selections collide. */
function threadKey(botId, backendId) {
  return JSON.stringify([botId ?? '', backendId ?? '']);
}

/**
 * Drop every lease a manager holds. A resolution that failed is never cached,
 * so the only thing to clear is a live one the caller wants re-resolved.
 */
export function clearVoiceBackendCache(backendManager) {
  leases.delete(backendManager);
}

/**
 * @param {{ list(): Promise<{ id: string }[]>, get(id: string): Promise<object> }} backendManager
 * @param {{ botId?: string, backendId?: string }} [thread]
 * @param {{ now?: () => number, ttlMs?: number }} [options] the injected clock
 *   and lease length, for tests
 * @returns {Promise<object | null>}
 */
export async function resolveVoiceBackend(backendManager, thread = {}, options = {}) {
  const { now = Date.now, ttlMs = VOICE_BACKEND_LEASE_MS } = options;
  const { botId, backendId } = thread ?? {};
  const key = threadKey(botId, backendId);
  let held = leases.get(backendManager);
  if (!held) {
    held = new Map();
    leases.set(backendManager, held);
  }
  const lease = held.get(key);
  if (lease && now() < lease.expiresAt) {
    // Refreshed on every hit, so a long call keeps its lease while it is
    // talking and re-resolves once it goes quiet for the full lease.
    lease.expiresAt = now() + ttlMs;
    return lease.backend;
  }

  const backend = await selectVoiceBackend(backendManager, { botId, backendId });
  // A null or thrown resolution is never cached: it names a broken environment
  // this instant, and caching it would keep the call answering `no_voice_backend`
  // for the rest of the lease after the operator fixed it.
  if (backend) held.set(key, { backend, expiresAt: now() + ttlMs });
  return backend;
}

/** The resolution itself, unchanged: which backend a thread speaks to. */
async function selectVoiceBackend(backendManager, { botId, backendId }) {
  if (botId && !backendId) {
    for (const entry of await backendManager.list()) {
      const candidate = await backendManager.get(entry.id).catch(() => null);
      if (candidate && typeof candidate.forBot === 'function') {
        try {
          return await candidate.forBot(botId);
        } catch {
          // try the next environment that can own the Bot
        }
      }
    }
  }
  if (!backendId && !botId) {
    // The backend that sends and streams a turn in one call (Hermes) is the
    // typed chat path. `list()[0]` is Claude Code on a typical Gate, so every
    // spoken turn on a Hermes thread went to Claude Code and failed
    // (2026-09-19).
    for (const entry of await backendManager.list()) {
      const candidate = await backendManager.get(entry.id).catch(() => null);
      if (candidate && typeof candidate.sendMessageStreaming === 'function') return candidate;
    }
  }
  const id = backendId ?? (await backendManager.list())[0]?.id;
  if (!id) return null;
  try {
    const backend = await backendManager.get(id);
    if (botId && typeof backend?.forBot === 'function') return await backend.forBot(botId);
    return backend;
  } catch {
    return null;
  }
}

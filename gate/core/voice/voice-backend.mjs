// ─── Which backend answers a spoken turn ────────────────────────────────
// A call carries the thread it was started from. A Bot names its environment;
// an explicit backendId pins one; an unscoped thread speaks to the chat path
// its typed turns use.
//
// A standalone caller resolves with a short per-thread lease: a backend can be
// replaced by an environment edit, and the Gate must not keep answering for the
// old one. A call cannot afford that on every turn — the measured gap between a
// first `final` and the first `reply` was 12.6 s, all of it resolution, and the
// lease then lapsed during the model's think time so every later turn paid it
// again. So a call takes a lease of its own, resolved once when the phone asks
// for the session and held for the call's whole life (`startVoiceBackendLease`).

/**
 * How long a resolved backend stays memoised for a standalone caller. A lease,
 * not a cache: a backend can be replaced by an environment edit (a different
 * adapter, new credentials, the Bot moved to another environment), and the Gate
 * must not keep answering for the old one. Twenty seconds is far below the gap
 * between an operator editing an environment and the next thing they say, and
 * far above the gap between two turns of one call — where the call's own lease
 * removes every repeat.
 */
const VOICE_BACKEND_LEASE_MS = 20_000;

/**
 * How long a call's resolve lives in the shared per-thread entry. The call keeps
 * its own copy for as long as it runs, so this is not what bounds it; it is long
 * enough that the entry the resolve leaves behind does not expire under a call
 * either.
 */
const VOICE_BACKEND_CALL_LEASE_MS = 30 * 60_000;

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

/**
 * The backend one call answers its turns with, resolved once.
 *
 * `voice.session.start` calls `backend()` without awaiting it, so the resolve —
 * which is a record read, a credential resolve and, over HTTP, a health fetch —
 * runs while the phone is still dialling, instead of inside the first reply.
 * The first turn awaits that same resolve rather than starting a second one, and
 * every turn after it takes the answer already held, so a call of any length
 * pays for one resolution.
 *
 * A failure is never remembered: a resolve that threw, or that found nothing,
 * is retried at the next `backend()` — the environment may well have been fixed
 * in between, and a cached failure would keep answering `no_voice_backend` for
 * the rest of the call.
 *
 * @param {{ list(): Promise<{ id: string }[]>, get(id: string): Promise<object> }} backendManager
 * @param {{ sessionId?: string, botId?: string, backendId?: string }} thread
 * @param {{ now?: () => number, ttlMs?: number }} [options] the injected clock
 *   and lease length, for tests
 * @returns {{ backend(): Promise<object | null> }}
 */
export function startVoiceBackendLease(backendManager, thread = {}, options = {}) {
  const { now = Date.now, ttlMs = VOICE_BACKEND_CALL_LEASE_MS } = options;
  let resolved = null;
  let pending = null;
  const resolveOnce = async () => {
    // A throw is a failure to remember, never to cache.
    const found = await resolveVoiceBackend(backendManager, thread, { now, ttlMs }).catch(() => null);
    if (found) {
      resolved = found;
      // A backend that has to create the session the turn runs in (Hermes does,
      // against a state.db that is cold after any restart) is asked to prepare it
      // now, while the call has nothing to send yet. Optional on purpose: a
      // backend with no session of its own has nothing to prepare, and one that
      // does not implement it is exactly as it was.
      if (typeof found.ensureSession === 'function') {
        Promise.resolve()
          .then(() => found.ensureSession(thread?.sessionId))
          .catch(() => undefined);
      }
    }
    return found;
  };
  const inFlight = () => {
    if (!pending) pending = resolveOnce();
    return pending;
  };
  return {
    async backend() {
      if (resolved) return resolved;
      // One resolve at a time: a turn that arrives while the call's own resolve
      // is still running waits for it rather than starting another.
      const running = inFlight();
      const found = await running;
      if (found) return found;
      // A failed or empty resolve is not remembered, so this turn asks again —
      // and only the caller that waited on the running one moves the chain on,
      // so two turns cannot both start a retry.
      if (pending === running) pending = resolveOnce();
      return inFlight();
    },
  };
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

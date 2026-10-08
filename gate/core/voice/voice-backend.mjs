import { selectDefaultBackend } from '../backend-resolution.mjs';

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
//
// An unscoped thread follows the same rule a typed request that names no
// backendId does (`selectDefaultBackend`, issue #1): the configured default if
// it is usable, else the first ready environment, else an error naming each
// candidate's state. Before, it took the first environment that could stream a
// turn whether or not it was running — on the Mac that was a Hermes that could
// not start, so every spoken turn failed while a ready OpenCode sat beside it.
// Streaming-capable environments still go first among the ready ones, which is
// what kept a Hermes thread's turns off Claude Code (2026-09-19).

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
 * @param {{ list(): Promise<{ id: string }[]>, get(id: string): Promise<object>,
 *   methodsOf?(id: string): Promise<Set<string> | null> }} backendManager
 * @param {{ botId?: string, backendId?: string }} [thread]
 * @param {{ now?: () => number, ttlMs?: number, selection?: VoiceBackendSelection }} [options]
 *   the injected clock and lease length, for tests; `selection` is the Gate's
 *   readiness view, which makes an unscoped thread pick default-then-ready
 * @returns {Promise<object | null>} null when a pinned or Bot thread cannot
 *   resolve; an unscoped thread with `selection` and nothing ready throws a
 *   `no_voice_backend` error whose message names each candidate's state
 */
export async function resolveVoiceBackend(backendManager, thread = {}, options = {}) {
  const { now = Date.now, ttlMs = VOICE_BACKEND_LEASE_MS, selection } = options;
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

  const backend = await selectVoiceBackend(backendManager, { botId, backendId }, selection);
  // A null or thrown resolution is never cached: it names a broken environment
  // this instant, and caching it would keep the call answering `no_voice_backend`
  // for the rest of the lease after the operator fixed it.
  if (backend) held.set(key, { backend, expiresAt: now() + ttlMs });
  return backend;
}

/**
 * @typedef {object} VoiceBackendSelection
 * @property {(id: string) => string | undefined} stateOf current coarse state, if known
 * @property {(id: string) => Promise<string | undefined>} [probe] probes an unprobed environment
 * @property {string} [defaultId] configured default backend id (VERSUTUS_GATE_DEFAULT_BACKEND)
 */

/** The resolution itself: which backend a thread speaks to. */
async function selectVoiceBackend(backendManager, { botId, backendId }, selection) {
  if (!backendId && !botId && selection) return selectReadyVoiceBackend(backendManager, selection);
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
    // Without a readiness view (a caller that has no environment service):
    // the backend that sends and streams a turn in one call (Hermes) is the
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

/** Whether an environment can send and stream a turn in one call, learned
 *  without starting it. Unknown (no `methodsOf`, or it answered null) is not
 *  counted as streaming: it keeps its place behind the known ones. */
async function streamsTurns(backendManager, id) {
  if (typeof backendManager.methodsOf !== 'function') return false;
  const methods = await backendManager.methodsOf(id).catch(() => null);
  return Boolean(methods?.has('sendMessageStreaming'));
}

/** An unscoped thread: the configured default if usable, else the first ready
 *  environment (streaming-capable ones first), else a clear error. Only the
 *  chosen environment is started. */
async function selectReadyVoiceBackend(backendManager, { stateOf, probe, defaultId }) {
  const entries = await backendManager.list();
  const streaming = [];
  const rest = [];
  for (const entry of entries) {
    (await streamsTurns(backendManager, entry.id) ? streaming : rest).push(entry);
  }
  const picked = await selectDefaultBackend({ entries: [...streaming, ...rest], stateOf, probe, defaultId });
  if (!picked.id) throw noVoiceBackend(picked.body.error.message, picked.body.error.code);
  try {
    return await backendManager.get(picked.id);
  } catch (error) {
    throw noVoiceBackend(
      `${picked.id} is ready but could not be attached: ${error?.message ?? error}`,
      'unknown_backend',
    );
  }
}

function noVoiceBackend(detail, reason) {
  const error = new Error(`No chat backend could answer this call. ${detail}`);
  error.code = 'no_voice_backend';
  error.reason = reason;
  return error;
}

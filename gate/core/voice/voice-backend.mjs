import { selectDefaultBackend } from '../backend-resolution.mjs';

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
//
// An unscoped thread follows the same rule a typed request that names no
// backendId does (`selectDefaultBackend`): the configured default if it is
// usable, else the first ready environment, else an error naming each
// candidate's state. Streaming-capable environments go first among the ready
// ones, which keeps a Hermes thread's turns off Claude Code.
//
// "Unscoped" has to be true before that rule is used. A phone that does not
// name the thread's backend is not a thread without one: the session it names
// was created in exactly one environment, and answering it from the default
// sends an OpenCode conversation to Claude Code, which exits at once (a live
// call, 2026-11-15: "claude-code exited with code 1" half a second after the
// operator stopped talking). So a call's thread is located first (`locate`):
// the caller says which environment holds the session, and only a session no
// environment claims falls through to the default.

/** Month names, so a call's title reads the same on a host without full ICU. */
const TITLE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The minute the last title named, and how many calls have opened inside it. */
let lastCallTitleBase = '';
let lastCallTitleSeq = 0;

/**
 * Title of the chat a call opens when its thread has no session yet.
 *
 * A call is titled as a call — "Call · 17 Nov 2026 · 14:32" — because it is the
 * operator's own conversation and the session list has to say where it came
 * from. The title must also be unique: Hermes recovers a duplicate title by
 * handing back the EXISTING session, so two calls opened in the same minute
 * would otherwise share one conversation (see `newThreadTitle` in server.mjs).
 * A repeat inside the same minute takes a numbered suffix, which leaves the
 * ordinary title clean.
 *
 * UTC, deliberately: a title is a record of when the call opened, and it must
 * not change meaning with the host's timezone or locale.
 */
export function newVoiceCallTitle(now = new Date()) {
  const day = String(now.getUTCDate()).padStart(2, '0');
  const month = TITLE_MONTHS[now.getUTCMonth()];
  const year = now.getUTCFullYear();
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const base = `Call · ${day} ${month} ${year} · ${hours}:${minutes}`;
  if (base === lastCallTitleBase) {
    lastCallTitleSeq += 1;
  } else {
    lastCallTitleBase = base;
    lastCallTitleSeq = 0;
  }
  return lastCallTitleSeq === 0 ? base : `${base} (${lastCallTitleSeq + 1})`;
}

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
 * `selection` is the Gate's readiness view. An unscoped call uses it, so the
 * one resolve still picks the configured default when it is usable.
 *
 * @param {{ list(): Promise<{ id: string }[]>, get(id: string): Promise<object> }} backendManager
 * @param {{ sessionId?: string, botId?: string, backendId?: string }} thread
 * `locate` names the environment (and Bot) that holds the thread's session when
 * the phone did not: `(thread) => Promise<thread>`. It runs before every
 * resolve, a throw or an unchanged thread leaves the thread as the phone sent
 * it, and `onResolved` is told what answered and how it was found.
 *
 * @param {{ now?: () => number, ttlMs?: number, selection?: VoiceBackendSelection,
 *   locate?: (thread: object) => Promise<object>,
 *   onResolved?: (detail: { backend: object, backendId?: string, via: string }) => void }} [options]
 * @returns {{ backend(): Promise<object | null> }}
 */
export function startVoiceBackendLease(backendManager, thread = {}, options = {}) {
  const {
    now = Date.now, ttlMs = VOICE_BACKEND_CALL_LEASE_MS, selection, locate = null, onResolved = null,
  } = options;
  let resolved = null;
  let pending = null;
  const resolveOnce = async () => {
    const located = await locateVoiceThread(thread, locate);
    // A throw is a failure to remember, never to cache.
    const found = await resolveVoiceBackend(backendManager, located.thread, { now, ttlMs, selection }).catch(() => null);
    if (found) {
      try {
        onResolved?.({ backend: found, backendId: located.thread?.backendId, via: located.via });
      } catch {
        // Telemetry is a witness, never a failure mode.
      }
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

/**
 * The thread a call resolves with, and how its environment was found:
 * `thread` when the phone named a backend or a Bot, `session` when the Gate
 * located the session's own environment, `default` when nobody claims it.
 */
export async function locateVoiceThread(thread, locate) {
  if (thread?.backendId || thread?.botId) return { thread, via: 'thread' };
  if (typeof locate !== 'function') return { thread, via: 'default' };
  try {
    const located = await locate(thread);
    if (located?.backendId || located?.botId) return { thread: located, via: 'session' };
  } catch {
    // A lookup that failed leaves the thread as the phone sent it.
  }
  return { thread, via: 'default' };
}

/** How long one environment may take to say whether it holds a session. */
export const SESSION_ENVIRONMENT_BOUND_MS = 4_000;

/**
 * Which attached environment holds a session, asked of the environments
 * themselves: the id of the first one that has it, or null.
 *
 * The Gate's own session index answers this for the environments it indexes
 * (Hermes), and nothing else: an OpenCode or Codex session is in no list the
 * Gate keeps, so a call on one was still "unscoped" and still went to the
 * default backend. Every environment is asked at once and the first that has
 * the session wins; one that errors, cannot be attached or runs out of time is
 * "not here" for this lookup, so a slow host never holds a call's start.
 *
 * @param {{ list(): Promise<{ id: string }[]>, get(id: string): Promise<object>,
 *   methodsOf?(id: string): Promise<Set<string> | null> }} backendManager
 * @param {string} sessionId
 * @param {{ boundMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function findSessionEnvironment(backendManager, sessionId, { boundMs = SESSION_ENVIRONMENT_BOUND_MS } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const entries = await backendManager.list().catch(() => []);
  if (!entries.length) return null;
  return new Promise((resolve) => {
    let open = entries.length;
    let settled = false;
    const answer = (id) => {
      if (settled) return;
      open -= 1;
      if (id) {
        settled = true;
        resolve(id);
      } else if (open === 0) {
        settled = true;
        resolve(null);
      }
    };
    for (const entry of entries) {
      const timer = setTimeout(() => answer(null), boundMs);
      timer.unref?.();
      environmentHoldsSession(backendManager, entry.id, sessionId).then(
        (holds) => { clearTimeout(timer); answer(holds ? entry.id : null); },
        () => { clearTimeout(timer); answer(null); },
      );
    }
  });
}

/** Whether one environment has a session: by id where it can, else by its list. */
async function environmentHoldsSession(backendManager, id, sessionId) {
  // Learned without starting the environment where the manager can say: one
  // that can do neither read is not started just to be told so.
  const methods = typeof backendManager.methodsOf === 'function'
    ? await backendManager.methodsOf(id).catch(() => null)
    : null;
  if (methods && !methods.has('getSession') && !methods.has('listSessions')) return false;
  const backend = await backendManager.get(id);
  if (typeof backend?.getSession === 'function') {
    try {
      const session = await backend.getSession(sessionId);
      if (session?.id === sessionId) return true;
    } catch (error) {
      // A named miss is an answer; anything else falls through to the list.
      if (error?.code === 'unknown_session' || error?.status === 404) return false;
    }
  }
  if (typeof backend?.listSessions !== 'function') return false;
  const sessions = await backend.listSessions();
  return Array.isArray(sessions) && sessions.some((session) => session?.id === sessionId);
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

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writeFileAtomic } from './atomic-file.mjs';
import { isGateInternalReason } from './model-fault.mjs';

// ─── Which models actually answer here ───
//
// A catalogue says what an environment CLAIMS to serve; nothing in it says
// whether a turn completes. `opencode-go` on the live host listed 42 models and
// refused every one of them (400 MissingSessionID), and they stayed in the
// picker because no catalogue anywhere was keeping score.
//
// The verdict comes from real turns only — no probe, nothing that burns quota
// or reads Hermes's state.db. Two consecutive failures hide the model for six
// hours, so a model that recovers (a key was fixed, a provider came back) is
// offered again without anybody re-reading anything; one answer clears it at
// once. A turn the caller stopped, a phone that disconnected and a Gate-side
// bound on the phone's own connection record nothing: none of them is evidence
// about the model.

/** Consecutive failures before a model stops being offered. */
export const FAILING_AFTER = 2;

/** How long a failing model stays hidden, then it is offered again. */
export const FAILING_TTL_MS = 6 * 60 * 60 * 1000;

/** How long one short error is kept for the reason the picker shows. */
const REASON_MAX = 120;

/**
 * The health key for one model under one backend.
 *
 * `gate` for the Gate's own providers (their rows carry no backendId), the
 * environment id for a CLI environment's rows — the same qualifier
 * backend-model-route.mjs files a turn under, so a verdict written by the chat
 * route is found by the catalogue that lists the model.
 */
export function modelHealthKey(backendId, qualifiedModelId) {
  if (typeof qualifiedModelId !== 'string' || !qualifiedModelId.trim()) return '';
  return `${backendId ?? 'gate'}|${qualifiedModelId.trim()}`;
}

/**
 * The scope a verdict is held under: the environment, narrowed to the Bot when
 * the turn or the catalogue is a Bot's. Each Bot is its own Hermes profile with
 * its own provider keys, so one Bot's refusals must not hide a model that
 * another Bot — or the bare environment — runs fine.
 */
export function healthScopeId(environmentId, botId) {
  if (!environmentId) return undefined;
  return botId ? `${environmentId}@${botId}` : environmentId;
}

/** A failure reason short enough to sit on one picker row. */
export function shortReason(value, max = REASON_MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * The model-health table: how each model has actually behaved on this host.
 *
 * Holds `{ failures, reason, since }` per key and answers `verdict(key)`:
 * `{ failing: true, reason, since, until }` for a model inside its hiding
 * window, null for everything else (healthy, never tried, or past the window —
 * the verdict simply expires, and the entry is dropped).
 *
 * `file` is optional: without it the table lives in memory, which is what a
 * unit test and a Gate told not to write state want. With it, the table is
 * reloaded lazily on first use (a corrupt or unreadable file is an empty
 * table, never a failed request) and written back atomically on a coalescing
 * timer, so a burst of failed turns costs one write and a half-written file is
 * never read back as a verdict.
 */
export function createModelHealth({
  file,
  now = Date.now,
  failingAfter = FAILING_AFTER,
  ttlMs = FAILING_TTL_MS,
  writeDelayMs = 250,
} = {}) {
  const entries = new Map();
  let loaded = file === undefined;
  let timer = null;
  let chain = Promise.resolve();
  let dirty = false;

  return { verdict, recordSuccess, recordFailure, size: () => entries.size };

  /** What the catalogue should do about `key`, or null when it is fine. */
  function verdict(key) {
    if (typeof key !== 'string' || !key) return null;
    load();
    const entry = entries.get(key);
    if (!entry) return null;
    const at = now();
    if (at - entry.since >= ttlMs) {
      // The hiding window is over: the model is offered again, and the stale
      // verdict is dropped rather than carried into the next write.
      entries.delete(key);
      schedulePersist();
      return null;
    }
    if (entry.failures < failingAfter) return null;
    return { failing: true, reason: entry.reason, failures: entry.failures, since: entry.since, until: entry.since + ttlMs };
  }

  /** A turn on this model answered, so nothing about it is failing any more. */
  function recordSuccess(key) {
    if (typeof key !== 'string' || !key) return;
    load();
    if (entries.delete(key)) schedulePersist();
  }

  /** A turn on this model did not answer. */
  function recordFailure(key, reason) {
    if (typeof key !== 'string' || !key) return;
    load();
    const previous = entries.get(key);
    const at = now();
    // A verdict from before the last hiding window is gone: a failure today
    // starts the count again rather than inheriting an expired one, or a model
    // that failed once yesterday would be hidden on its first failure today.
    const counted = previous && at - previous.since < ttlMs ? previous : null;
    entries.set(key, {
      failures: (counted?.failures ?? 0) + 1,
      reason: shortReason(reason) || counted?.reason || 'the turn did not complete',
      since: at,
    });
    schedulePersist();
  }

  function load() {
    if (loaded) return;
    loaded = true;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // Absent, unreadable or corrupt: start empty. Health is a hint the Gate
      // offers out of its own memory, and a bad file must not fail a request.
      return;
    }
    const models = parsed && typeof parsed === 'object' ? parsed.models : null;
    if (!models || typeof models !== 'object') return;
    const at = now();
    // A verdict whose reason is one of the Gate's own fault signatures was never
    // evidence about a model — 2026-10-02 hid the operator's OpenCode models for
    // six hours on `Unexpected end of JSON input` — so it is dropped here rather
    // than waited out, and the file is rewritten without it: nothing has to be
    // edited by hand for the table to heal itself.
    let dropped = false;
    for (const [key, value] of Object.entries(models)) {
      if (!value || typeof value !== 'object') continue;
      const since = Number(value.since);
      if (!Number.isFinite(since) || at - since >= ttlMs) continue;
      const reason = typeof value.reason === 'string' ? value.reason : '';
      if (reason && isGateInternalReason(reason)) {
        dropped = true;
        continue;
      }
      const failures = Number(value.failures);
      entries.set(key, {
        failures: Number.isFinite(failures) && failures > 0 ? failures : 0,
        reason,
        since,
      });
    }
    if (dropped) schedulePersist();
  }

  function schedulePersist() {
    dirty = true;
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      chain = chain.then(write).catch(() => {});
    }, writeDelayMs);
    timer.unref?.();
  }

  async function write() {
    if (!file || !dirty) return;
    dirty = false;
    const models = Object.fromEntries(entries);
    await mkdir(dirname(file), { recursive: true }).catch(() => {});
    await writeFileAtomic(file, JSON.stringify({ models }, null, 2), { encoding: 'utf8' });
  }
}
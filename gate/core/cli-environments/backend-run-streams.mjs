import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Durable replay for Hermes-kind (agentic) run streams.
 *
 * The Gate relays `/v1/runs/{id}/events` byte-for-byte from the fronted
 * Hermes, but Hermes buffers a run's events only while it is live: once the
 * run finishes, replaying its stream 404s there — and the Gate used to turn
 * that upstream refusal into a generic 500. That broke the acceptance story
 * "finished task stays provable": the environments archive
 * (run-archive.mjs) covers CLI-environment runs under <gateHome>/runs, but
 * agentic runs had no disk counterpart.
 *
 * This store tees the live stream, exactly as emitted, into
 *
 *   <dir>/<runId>.sse
 *
 * one file per run, raw SSE bytes. A later replay answers from disk — even
 * after Hermes dropped its live buffer, after a Gate restart, or while
 * Hermes is down entirely. A run id may never be reused by the upstream
 * (Hermes generates unique ids), so each file maps one run.
 *
 * Writes are SYNCHRONOUS on purpose, the same durability argument as
 * run-archive.mjs: when the relay has forwarded an event the bytes are
 * already on disk, so a crash can only tear the trailing frame (the client
 * drops one malformed frame, never the whole history).
 *
 * A single writer per run: the first live relay claims the tee via
 * `begin()`; concurrent relays of the same live run just pass bytes through
 * without appending, so a file never holds duplicated frames.
 */

const DEFAULT_MAX_BYTES_PER_RUN = 8 * 1024 * 1024;
const DEFAULT_MAX_RUNS = 100;

/** Run ids arrive from any API caller and end up as path segments. */
function safeSegment(value, fallback = 'run') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = cleaned.slice(0, 120);
  return trimmed.length > 0 ? trimmed : fallback;
}

export function createBackendRunStreams(
  dir,
  { maxBytesPerRun = DEFAULT_MAX_BYTES_PER_RUN, maxRuns = DEFAULT_MAX_RUNS } = {},
) {
  /** Runs currently being teed by a live relay. */
  const active = new Set();
  /** Bytes already appended this process, seeded from disk on first touch. */
  const sizes = new Map();
  let appends = 0;

  function fileFor(runId) {
    return join(dir, `${safeSegment(runId)}.sse`);
  }

  async function prune() {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const files = names.filter((name) => name.endsWith('.sse'));
    if (files.length <= maxRuns) return;
    const byAge = [];
    for (const name of files) {
      try {
        byAge.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
      } catch {
        // Vanished between listing and stat — ignore.
      }
    }
    byAge.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const stale of byAge.slice(0, files.length - maxRuns)) {
      await rm(join(dir, stale.name), { force: true }).catch(() => {});
    }
  }

  return {
    /** True while a live relay is teeing this run. */
    isActive(runId) {
      return active.has(runId);
    },

    /**
     * Claim the tee for a live run. Returns true for exactly the first
     * caller; every concurrent relay of the same run returns false and must
     * pass bytes through without appending.
     */
    begin(runId) {
      if (active.has(runId)) return false;
      active.add(runId);
      return true;
    },

    /** Release the tee. Called by the tee-holder when its relay ends. */
    end(runId) {
      active.delete(runId);
    },

    /**
     * Append one raw chunk to the run's file. Only the tee-holder may call
     * this. Never throws: archiving must not break the live relay.
     */
    append(runId, chunk) {
      if (!active.has(runId)) return;
      let size = sizes.get(runId);
      if (size === undefined) {
        // First touch this process: a file may already exist from before a
        // restart (the run's earlier frames were relayed by the old process).
        try {
          size = statSync(fileFor(runId)).size;
        } catch {
          size = 0;
        }
        sizes.set(runId, size);
      }
      if (size >= maxBytesPerRun) return; // Bound a pathological endless stream.
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const allowed = maxBytesPerRun - size;
      const slice = bytes.length > allowed ? bytes.subarray(0, allowed) : bytes;
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(fileFor(runId), slice);
        sizes.set(runId, size + slice.length);
        // Pruning is a syscall walk; do it occasionally, never per frame.
        if (++appends % 16 === 0) prune().catch(() => {});
      } catch {
        // Archive failures never take the live relay down with them.
      }
    },

    /** The archived bytes for a run, or null when nothing was recorded. */
    async read(runId) {
      try {
        return await readFile(fileFor(runId));
      } catch {
        return null;
      }
    },
  };
}
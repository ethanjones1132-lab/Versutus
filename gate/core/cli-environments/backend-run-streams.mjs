import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
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
 *
 * COMPLETENESS — a file alone is not the truth:
 *
 * A relay can die mid-run (Gate restart, crash). The bytes on disk then hold
 * only a PREFIX of the stream, and serving that prefix as the verdict would
 * silently truncate the operator's evidence. So each run earns a sidecar
 *
 *   <dir>/<runId>.complete
 *
 * written ONLY when a relay reaches the stream's clean end (`markComplete`).
 * A capped run (the 8 MiB bound) never earns it — its file is a truncated
 * prefix no matter how the stream ended. Replays consult the marker: an
 * unmarked file is re-streamed live from the upstream and heals, or is
 * served back explicitly flagged as incomplete when the upstream refuses.
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
  /** Runs whose archive hit the byte cap: truncated prefix, never complete. */
  const capped = new Set();
  let appends = 0;

  function fileFor(runId) {
    return join(dir, `${safeSegment(runId)}.sse`);
  }

  function markerFor(runId) {
    return join(dir, `${safeSegment(runId)}.complete`);
  }

  async function prune(activeAtEnqueue) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    // Runs being relayed when this prune was enqueued must never be deleted.
    // The walk runs asynchronously, well after the triggering append's
    // synchronous burst may have ENDED those relays, so reading the live
    // `active` set here would already be wrong (every burst ends its runs
    // before the microtask runs). The snapshot is captured synchronously by
    // the caller — every run it names was mid-relay at that instant — and
    // keeps a stale-mtime file (a restart survivor) from being pruned out
    // from under a fresh relay that is still streaming it.
    const activeNames = new Set([...activeAtEnqueue].map((id) => `${safeSegment(id)}.sse`));
    const files = names.filter((name) => name.endsWith('.sse') && !activeNames.has(name));
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
      // The completeness marker dies with its stream: an orphan marker must
      // not bless a future file that happens to reuse the same segment.
      await rm(join(dir, `${stale.name.slice(0, -4)}.complete`), { force: true }).catch(() => {});
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
     *
     * A file WITHOUT its completeness marker is a partial from a relay that
     * never reached the stream's end (an older process died mid-run). The
     * upstream re-streams a live run from its first event, so re-teeing into
     * the same file would double every earlier frame — begin() starts the
     * file over. A marked file is complete history and is never reset.
     */
    begin(runId) {
      if (active.has(runId)) return false;
      active.add(runId);
      capped.delete(runId);
      if (!existsSync(markerFor(runId))) {
        try {
          truncateSync(fileFor(runId), 0);
          sizes.delete(runId);
        } catch {
          // No file yet (or no dir yet) — nothing to reset.
        }
      }
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
      if (size >= maxBytesPerRun) {
        capped.add(runId); // Bound a pathological endless stream; the truncation is now visible.
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const allowed = maxBytesPerRun - size;
      const slice = bytes.length > allowed ? bytes.subarray(0, allowed) : bytes;
      if (bytes.length > allowed) capped.add(runId);
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(fileFor(runId), slice);
        sizes.set(runId, size + slice.length);
        // Pruning is a syscall walk; do it occasionally, never per frame.
        // The active snapshot must be taken HERE, synchronously: the walk
        // itself resolves later, after this run's burst may have ended.
        if (++appends % 16 === 0) prune(new Set(active)).catch(() => {});
      } catch {
        // Archive failures never take the live relay down with them.
      }
    },

    /**
     * The relay reached the stream's clean end: the file now holds the whole
     * stream as the upstream presented it and earns its completeness marker.
     * A capped run never earns it — the file is a truncated prefix, and a
     * replay must not present a cut-off stream as the full story.
     */
    markComplete(runId) {
      if (capped.has(runId)) return;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(markerFor(runId), 'complete\n', 'utf8');
      } catch {
        // Archive failures never take the live relay down with them.
      }
    },

    /** True when the run's archive carries its completeness marker. */
    isComplete(runId) {
      return existsSync(markerFor(runId));
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
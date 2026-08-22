import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Upper bound on one environment's archived runs. listRuns() already caps at
 * 50 per response; the archive keeps a wider tail so an operator can still
 * open last week's run from Recent runs without the folder growing forever.
 */
const DEFAULT_MAX_RUNS_PER_ENVIRONMENT = 100;

/**
 * Environment ids and run ids end up as path segments. The schema only
 * requires id to be a string and runId may arrive from any API caller, so
 * every segment is reduced to a safe charset before it touches the disk.
 */
function safeSegment(value, fallback = 'unnamed') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = cleaned.slice(0, 120);
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Durable run history for CLI environments: one JSONL file per run under
 *
 *   <archiveDir>/<environmentId>/<runId>.json
 *
 * Line 1 is the run meta (who, what, when); each following line is one event
 * exactly as it was emitted on the wire. A Gate restart used to erase every
 * past run with the process — the phone's "Recent runs" recovery path and the
 * buyer's acceptance evidence died with the console window. With an archive,
 * discovery and replay answer from disk after a restart, so a finished task
 * stays provable across Gate restarts, reboots, and crashes.
 *
 * Writes on the live path are SYNCHRONOUS on purpose: when emit() returns,
 * the event is already on disk. Async appends would let a restart that races
 * an in-flight write hydrate from a stale tail, synthesize a verdict at the
 * wrong sequence, and interleave it with the late event — a corrupted history
 * that reads as two verdicts. Sync appends make file order equal emit order,
 * and an actual process death can only ever tear the trailing line (load()
 * drops unparsable fragments instead of failing). CLI output arrives at
 * human speeds, so the per-event syscall cost is negligible.
 */
export function createRunArchive(dir, { maxRunsPerEnvironment = DEFAULT_MAX_RUNS_PER_ENVIRONMENT } = {}) {
  let loaded = false;
  const madeDirs = new Set();

  function environmentDir(environmentId) {
    const path = join(dir, safeSegment(environmentId));
    if (!madeDirs.has(path)) {
      mkdirSync(path, { recursive: true });
      madeDirs.add(path);
    }
    return path;
  }

  function fileFor(environmentId, runId) {
    return join(environmentDir(environmentId), `${safeSegment(runId)}.json`);
  }

  return {
    /**
     * Create (or reset) a run's file with its meta line. Called once when the
     * run starts; every later event appends after it in order. Fire-and-forget
     * by contract — persistence must never break or stall the live run (the
     * event log already wraps its onEmit subscriber in a try/catch).
     */
    record(meta) {
      writeFileSync(fileFor(meta.environmentId, meta.runId), `${JSON.stringify(meta)}\n`, 'utf8');
    },

    /**
     * Append one emitted event, synchronously. See the durability note above.
     */
    append(environmentId, runId, event) {
      appendFileSync(fileFor(environmentId, runId), `${JSON.stringify(event)}\n`, 'utf8');
    },

    /**
     * Read every archived run back. Returns [{ meta, events }] sorted oldest
     * first within each environment, pruning runs beyond the cap (oldest go
     * first). Torn lines from an unclean shutdown are skipped, never fatal.
     * Idempotent: a second call returns nothing — hydration happens once.
     */
    async load() {
      if (loaded) return [];
      loaded = true;
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const restored = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const environmentPath = join(dir, entry.name);
        const files = (await readdir(environmentPath)).filter((name) => name.endsWith('.json')).sort();
        const runs = [];
        for (const name of files) {
          const path = join(environmentPath, name);
          try {
            const parsed = await readRunFile(path);
            if (parsed) runs.push(parsed);
          } catch {
            // An unreadable file must never keep the Gate from starting.
          }
        }
        runs.sort((a, b) => a.meta.startedAtMs - b.meta.startedAtMs);
        const excess = runs.slice(0, Math.max(0, runs.length - maxRunsPerEnvironment));
        for (const stale of excess) {
          await rm(stale.path, { force: true }).catch(() => {});
        }
        restored.push(...runs.slice(-maxRunsPerEnvironment));
      }
      return restored;
    },
  };
}

async function readRunFile(path) {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const meta = JSON.parse(lines[0]);
  if (!meta || typeof meta.runId !== 'string' || typeof meta.environmentId !== 'string') return null;
  const events = [];
  for (const line of lines.slice(1)) {
    try {
      const event = JSON.parse(line);
      if (event && typeof event.type === 'string' && typeof event.sequence === 'number') {
        events.push(event);
      }
    } catch {
      // Torn tail from an unclean shutdown — drop the fragment and keep the
      // rest of the history usable.
    }
  }
  return { meta, events, path };
}

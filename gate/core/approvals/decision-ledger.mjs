import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AUDIT_MAX_AGE_MS, AUDIT_MAX_BYTES, deviceTag } from '../voice/audit.mjs';

const DECISIONS = new Set(['approved', 'denied', 'expired', 'withdrawn', 'gate-restart']);
const PENDING_FILE = /^[a-f0-9]{16}\.json$/;

// Pending records contain the same closed projection as decisions. They are
// never executable on recovery. A durable decision takes precedence over a
// leftover marker if the Gate stopped between appending and unlinking it.
export function createDecisionLedger({
  dir, now = Date.now, maxAgeMs = AUDIT_MAX_AGE_MS, maxBytes = AUDIT_MAX_BYTES,
  log = console.warn,
}) {
  const path = join(dir, 'decisions.jsonl');
  const rotated = `${path}.1`;
  const pendingDir = join(dir, 'pending');
  const marker = (id) => join(pendingDir, `${id}.json`);
  const writeOptions = { encoding: 'utf8', mode: 0o600, flush: true };
  let lastSweep = -Infinity;

  function rows(file) {
    let text;
    try { text = readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return text.split('\n').flatMap((line) => {
      try {
        const row = JSON.parse(line);
        return DECISIONS.has(row?.decision) ? [row] : [];
      } catch { return []; }
    });
  }

  function retain() {
    const cutoff = now() - maxAgeMs;
    for (const file of [path, rotated]) {
      const all = rows(file);
      const keep = all.filter((row) => Date.parse(row.decidedAt) > cutoff);
      if (all.length === keep.length) continue;
      if (!keep.length) rmSync(file, { force: true });
      else {
        const temp = `${file}.retaining`;
        writeFileSync(temp, keep.map((row) => `${JSON.stringify(row)}\n`).join(''), writeOptions);
        renameSync(temp, file);
      }
    }
    lastSweep = now();
  }

  function record(base, decision, deviceId) {
    const decidedAt = now();
    const row = {
      ...base,
      decidedAt: new Date(decidedAt).toISOString(),
      decision,
      decidedBy: deviceId ? deviceTag(deviceId) : null,
      latencyMs: Math.max(0, decidedAt - Date.parse(base.requestedAt)),
    };
    const line = `${JSON.stringify(row)}\n`;
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    let separator = '';
    if (size && size + Buffer.byteLength(line) > maxBytes) {
      rmSync(rotated, { force: true });
      renameSync(path, rotated);
    } else if (size) {
      const fd = openSync(path, 'r');
      try {
        const last = Buffer.alloc(1);
        if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) separator = '\n';
      } finally { closeSync(fd); }
    }
    // A newline also fences off a possible torn last write after a crash.
    // Normal records always occupy one line and never include raw inputs.
    appendFileSync(path, `${separator}${line}`, writeOptions);
    try { rmSync(marker(base.approvalId), { force: true }); }
    catch { log('approvals: could not clear decision recovery marker'); }
    return row;
  }

  mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
  const files = readdirSync(pendingDir).filter((file) => PENDING_FILE.test(file));
  if (files.length) {
    const decided = new Set([...rows(path), ...rows(rotated)].map((row) => row.approvalId));
    for (const file of files) {
      const id = file.slice(0, -5);
      if (decided.has(id)) { rmSync(marker(id), { force: true }); continue; }
      const base = JSON.parse(readFileSync(marker(id), 'utf8'));
      record(base, 'gate-restart');
    }
  }
  retain();
  const sweep = setInterval(() => {
    try { retain(); } catch { log('approvals: could not prune decision ledger'); }
  }, Math.min(maxAgeMs, 60 * 60_000));
  sweep.unref?.();

  return {
    path,
    begin(base) {
      const file = marker(base.approvalId);
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(base), writeOptions);
      renameSync(temp, file);
    },
    record(base, decision, deviceId) {
      if (now() - lastSweep >= Math.min(maxAgeMs, 60 * 60_000)) retain();
      return record(base, decision, deviceId);
    },
    recent(limit = 50) {
      const count = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
      const cutoff = now() - maxAgeMs;
      return [...rows(rotated), ...rows(path)].reverse()
        .filter((row) => Date.parse(row.decidedAt) > cutoff).slice(0, count);
    },
    close() { clearInterval(sweep); },
  };
}

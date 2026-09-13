// ─── The voice audit line ────────────────────────────────────────────────
// One line per call, appended to `<gateHome>/voice/audit.jsonl`. It carries
// counts and names, never words: the field list is closed, and a value that is
// not a scalar is dropped, so a transcript cannot ride along inside an object
// field. §4.9 / M9.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AUDIT_FIELDS = Object.freeze([
  'ts',
  'deviceId',
  'botId',
  'engine',
  'fellBackFrom',
  'turns',
  'secondsListening',
  'secondsSpeaking',
  'p50FirstAudioMs',
  'error',
]);

/** Scalars pass; an object or array can only be a place text hides, so it is dropped. */
function scalar(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' ? null : value;
}

/** Pick the fixed fields out of a call summary. Anything else is not written. */
export function buildAuditLine(summary = {}, now = () => new Date().toISOString()) {
  const providedTs = scalar(summary.ts);
  const line = { ts: typeof providedTs === 'string' && providedTs ? providedTs : now() };
  for (const field of AUDIT_FIELDS) {
    if (field === 'ts') continue;
    line[field] = scalar(summary[field]);
  }
  if (typeof line.turns !== 'number') line.turns = 0;
  return line;
}

/** A JSONL sink for audit lines; the directory is created on first use. */
export function createVoiceAudit({
  dir,
  now = () => new Date().toISOString(),
  appendFile = appendFileSync,
} = {}) {
  const path = join(dir, 'audit.jsonl');
  let ready = false;
  return {
    path,
    record(summary) {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true });
        ready = true;
      }
      appendFile(path, `${JSON.stringify(buildAuditLine(summary, now))}\n`);
    },
  };
}

// ─── The voice audit line ────────────────────────────────────────────────
// One line per call, appended to `<gateHome>/voice/audit.jsonl`. It carries
// counts and names, never words: the field list is closed, and a value that is
// not a scalar is dropped, so a transcript cannot ride along inside an object
// field. §4.9 / M9.
//
// It names the phone only by `deviceTag`. The operator still follows one phone
// across calls, but neither the audit nor a Gate log line holds the raw id the
// pairing gave it (S4). D6 gives the file 30 days: past that age, or past a size
// bound, it becomes `audit.jsonl.1`, replacing the prior one, so at most one
// old file is kept.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * A stable, non-reversible handle for a device. A raw device id is an
 * identifier the operator does not need on disk, and the same phone must still
 * be greppable across attempts, so the tag is a fixed hash prefix. Exported so
 * the Gate log (voice-rpc.mjs) and this audit name a phone the same way.
 */
export function deviceTag(deviceId) {
  return createHash('sha256').update(String(deviceId)).digest('hex').slice(0, 12);
}

/**
 * What a voice log may say about text the Gate did not author. A backend or
 * worker error can quote the prompt or transcript it failed on, so the words
 * stay out of both the log and the audit (S3): the marker says a value existed,
 * and the count is enough to tell a terse failure from a detailed one.
 */
export function redactedLogText(value) {
  if (value === undefined || value === null) return 'none';
  const text = String(value);
  return text ? `redacted chars=${text.length}` : 'none';
}

// D6: one month is the whole retention. The size bound is the second half of
// the same promise — a Gate that makes a call every few minutes must not grow
// the file without limit inside its month.
export const AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
// A fixed name, so a rotation replaces the prior file instead of adding one.
export const AUDIT_ROTATED_SUFFIX = '.1';
// Enough for one whole audit line, so the age comes from a parsed `ts`. A
// longer first line is not a line this module wrote; its age reads as unknown
// rather than guessed from a truncated parse.
const FIRST_LINE_BYTES = 8192;

export const AUDIT_FIELDS = Object.freeze([
  'ts',
  'deviceTag',
  'botId',
  'engine',
  'fellBackFrom',
  'turns',
  // What the call heard and what it did with it: finals, the utterances those
  // were gathered into, and the ones that had to wait for the turn in flight.
  // Without them a call that dropped speech counted the same as a clean one.
  'finals',
  'partials',
  'utterances',
  'queued',
  'continued',
  // Speech the call heard but did not act on, and the interruptions it took:
  // a final Whisper found no speech in, operator barge-ins, and speech the
  // playback echo gate refused while the PC was speaking. Counts only.
  'spuriousDrops',
  'bargeIns',
  'echoGated',
  // Turns that were still running when the phone went away and were parked to
  // finish on the PC (a count; what was said stays off disk).
  'parkedTurns',
  'secondsListening',
  'secondsSpeaking',
  'p50FirstAudioMs',
  'p90FirstAudioMs',
  'p50FirstReplyMs',
  'p90FirstReplyMs',
  'p50EosToCommitMs',
  'p90EosToCommitMs',
  'p50DecodeMs',
  'p90DecodeMs',
  'p50SentenceToPcmMs',
  'p90SentenceToPcmMs',
  'p50PlayedMs',
  'p90PlayedMs',
  'error',
]);

/** Scalars pass; an object or array can only be a place text hides, so it is dropped. */
function scalar(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' ? null : value;
}

/**
 * The tag a line stores. Callers hand the sink the raw id they already hold
 * (the media socket passes its session's), and the tag is derived here, so
 * there is one place that can leak an id and one place to audit.
 */
function taggedDevice(summary) {
  const explicit = scalar(summary.deviceTag);
  if (typeof explicit === 'string' && explicit) return explicit;
  const raw = summary.deviceId;
  if (raw === undefined || raw === null || typeof raw === 'object') return null;
  return deviceTag(raw);
}

/**
 * The audit's `error` field is one of the reducer's end reasons: a short code
 * the Gate wrote, never a backend's sentence. Anything else handed to the sink
 * is reduced to the same size marker the logs use (S3), so a stray message
 * cannot turn into transcript bytes on disk.
 */
function auditError(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  if (!value) return null;
  return /^[a-z][a-z0-9-]{0,31}$/i.test(value) ? value : redactedLogText(value);
}

/** Pick the fixed fields out of a call summary. Anything else is not written. */
export function buildAuditLine(summary = {}, now = () => new Date().toISOString()) {
  const providedTs = scalar(summary.ts);
  const line = { ts: typeof providedTs === 'string' && providedTs ? providedTs : now() };
  for (const field of AUDIT_FIELDS) {
    if (field === 'ts') continue;
    if (field === 'deviceTag') line[field] = taggedDevice(summary);
    else if (field === 'error') line[field] = auditError(summary[field]);
    else line[field] = scalar(summary[field]);
  }
  if (typeof line.turns !== 'number') line.turns = 0;
  return line;
}

/**
 * The `ts` on the file's first line, or null when there is no readable line.
 * The OLDEST line decides rotation; the newest line says nothing about how long
 * the file has been growing.
 */
function firstLineTimestamp(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(FIRST_LINE_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, read).toString('utf8').split('\n', 1)[0];
    const ts = JSON.parse(line)?.ts;
    return typeof ts === 'string' ? ts : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close that fails leaves nothing to protect.
      }
    }
  }
}

/** Past its retention, or over the size bound: either one means rotate now. */
function auditIsFull(path, { maxAgeMs, maxBytes, nowIso }) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    // No file yet: there is nothing to rotate.
    return false;
  }
  if (size > maxBytes) return true;
  const firstAt = Date.parse(firstLineTimestamp(path));
  const currentAt = Date.parse(nowIso);
  if (!Number.isFinite(firstAt) || !Number.isFinite(currentAt)) return false;
  return currentAt - firstAt > maxAgeMs;
}

/** Move the audit aside, replacing the one prior file. Throws on an fs failure. */
function rotateAudit(path) {
  const previous = `${path}${AUDIT_ROTATED_SUFFIX}`;
  // Windows refuses to rename onto an existing name, and the name is reused
  // for ever, so the prior file is removed first.
  rmSync(previous, { force: true });
  renameSync(path, previous);
}

/**
 * The diagnostic part of a failed fs call: Node sets `code` (`EPERM`,
 * `ENOSPC`), and a message with no code still leads with the operating
 * system's own. The rest — which can name a path — never reaches the log (S3).
 */
function auditErrorCode(error) {
  const code = error?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) return code;
  const lead = /^([A-Z][A-Z0-9_]{1,31})\b/.exec(String(error?.message ?? ''));
  return lead ? lead[1] : 'unknown';
}

/** A JSONL sink for audit lines; the directory is created on first use. */
export function createVoiceAudit({
  dir,
  now = () => new Date().toISOString(),
  appendFile = appendFileSync,
  rotateFile = rotateAudit,
  maxAgeMs = AUDIT_MAX_AGE_MS,
  maxBytes = AUDIT_MAX_BYTES,
  // Failed housekeeping would otherwise be invisible in the Gate log. One line
  // per failure streak is enough to show an operator the file cannot move.
  log = console.log,
} = {}) {
  const path = join(dir, 'audit.jsonl');
  let ready = false;
  let rotateFailureLogged = false;
  return {
    path,
    record(summary) {
      // The reducer writes this line on its way out of a call, so a log
      // directory that cannot be made must not throw out of `end()`: the
      // socket would never reach its terminal frames or free the call. Skip
      // the line, keep `ready` false, and let a later call try again.
      if (!ready) {
        try {
          mkdirSync(dirname(path), { recursive: true });
        } catch {
          return false;
        }
        ready = true;
      }
      // Rotation is best-effort: a file that cannot be moved still takes the
      // line. A call's teardown must never fail because housekeeping did, so
      // the failure is reported once; a later rotation that succeeds re-arms
      // the report, because a recurrence is a new thing to see.
      try {
        if (auditIsFull(path, { maxAgeMs, maxBytes, nowIso: now() })) {
          rotateFile(path);
          rotateFailureLogged = false;
        }
      } catch (error) {
        if (!rotateFailureLogged) {
          rotateFailureLogged = true;
          log(`voice.audit rotate failed reason=${auditErrorCode(error)}`);
        }
      }
      appendFile(path, `${JSON.stringify(buildAuditLine(summary, now))}\n`);
      return true;
    },
  };
}

// ─── Per-turn file changes ─────────────────────────────────────────
// VS-094: a finished turn can say what it changed, not just what it said.
//
// Everything here is pure. The impure seams (the stream reducer, the journal
// fetch and local storage) live outside this module; this module only turns
// evidence they hand it into a capped, serialisable record and one quiet line
// of copy.
//
// The rules come from docs/plans/2026-11-26-turn-change-list-design.md:
// tool args are live-stream only, so a `Read`, `Grep`, `Glob` or `cat` path is
// never a change; a `Write`/`Edit` path is touched, and only an OpenCode diff
// snapshot that differs before/after may promote it to "changed" with counts.
// A path is stored, never contents, a patch, raw `detail` or tool output.

import type { ChatMessage } from '@/lib/gateway/types';

export type TurnChangeStatus = 'added' | 'modified' | 'deleted' | 'unknown';
export type TurnChangeEvidence = 'diff' | 'tool';

/** One row of a turn's change list. Counts exist only with diff evidence. */
export type TurnChangeFile = {
  path: string;
  status: TurnChangeStatus;
  additions?: number;
  deletions?: number;
  evidence: TurnChangeEvidence;
  /** Calls that named this path. Empty means the diff row had no watching call. */
  callIds: string[];
};

/** The storeable per-turn record (design section 3). Paths and counts only. */
export type TurnChangeRecord = {
  v: 1;
  turnId: string;
  sessionId: string;
  backendId: string;
  startedAt: number;
  endedAt: number;
  files: TurnChangeFile[];
  truncated: boolean;
  omitted: number;
};

export type FileEvidenceKind = 'write' | 'delete';
export type FileEvidenceConfidence = 'strong' | 'weak' | 'none';

/**
 * What one tool call says about files.
 *
 * `paths` is empty for a non-write call (`Read`, `Grep`, `Glob`, `cat`, a plain
 * `ls`, or any input we could not parse whole). `kind`/`confidence` are `null`
 * and `'none'` in that case, so a caller can never mistake "no paths" for a
 * weak claim.
 */
export type FileEvidence = {
  paths: string[];
  kind: FileEvidenceKind | null;
  confidence: FileEvidenceConfidence;
};

export type FileEvidenceInput = {
  backend: string;
  name: string;
  /**
   * `ChatToolCall.detail` text. An object is accepted too so fixtures can spell
   * out the parsed input; either way the value is read for paths and discarded.
   */
  detail?: string | Record<string, unknown> | null;
};

export type TurnObservation = {
  callId?: string;
  tool: string;
  path: string;
  kind: FileEvidenceKind;
  confidence: FileEvidenceConfidence;
  seenAt?: number;
};

/** Everything one turn observed, plus the journal window when it exists. */
export type TurnObservations = {
  turnId: string;
  sessionId: string;
  backendId: string;
  startedAt?: number;
  endedAt?: number;
  items: readonly TurnObservation[];
};

/**
 * One row of an OpenCode session diff. `patch` is compared to decide whether
 * the row moved during the window; it is never copied into a record.
 */
export type TurnDiffRow = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  oldPath?: string;
  previousPath?: string;
};

export type TurnJournalMeta = {
  turnId?: string;
  status?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number | null;
};

export type BoundTurnWindow = {
  turnId: string;
  startedAt: number;
  endedAt: number;
};

export type TurnChangeCaps = {
  maxPaths?: number;
  maxBytes?: number;
};

export type TurnChangeSummary = {
  label: string;
  tone: 'neutral' | 'warning';
};

export const DEFAULT_TURN_CHANGE_MAX_PATHS = 200;
export const DEFAULT_TURN_CHANGE_MAX_BYTES = 32 * 1024;
export const TURN_CHANGE_MAX_PATH_CHARS = 512;

const WORKSPACE_SEGMENTS = new Set([
  'src',
  'app',
  'lib',
  'packages',
  'modules',
  'gate',
  'docs',
  'tests',
  '__tests__',
  'scripts',
  'assets',
  'website',
  'site',
  'e2e',
  'components',
  'hooks',
  'constants',
]);

const CLAUDE_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit']);
const OPENCODE_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'patch', 'create']);
const CODEX_COMMAND_TOOLS = new Set(['exec', 'shell', 'command']);

const REDIRECTION = /(?:^|[\s;&|()])(?:\d?>>?)\s*("[^"]+"|'[^']+'|[^\s;&|()<>]+)/g;

function emptyEvidence(): FileEvidence {
  return { paths: [], kind: null, confidence: 'none' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Project a tool-reported path onto the workspace.
 *
 * The app does not know the absolute workspace root, so an absolute path is
 * reduced to the first segment that looks like a project root (`src`, `lib`,
 * `gate`, …); failing that, the mount (and a home directory's user/project
 * segments) is dropped. The design's `C:\repo\src\a.ts` therefore becomes
 * `src/a.ts`, and a home-directory prefix cannot ride into logs.
 *
 * `..` is refused whole rather than resolved: a path outside the workspace is
 * not evidence we can show.
 */
function normalizePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (!candidate || candidate.includes('\0')) return null;
  candidate = candidate.replace(/\\/g, '/');
  if (/^file:\/\//i.test(candidate)) candidate = candidate.replace(/^file:\/\//i, '');
  const absolute = /^[A-Za-z]:\//.test(candidate) || candidate.startsWith('/');
  if (/^[A-Za-z]:\//.test(candidate)) candidate = candidate.slice(2);
  candidate = candidate.replace(/^\/+/, '');
  const segments = candidate.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;

  if (absolute) {
    const marker = segments.findIndex((segment) => WORKSPACE_SEGMENTS.has(segment.toLowerCase()));
    if (marker > 0) {
      segments.splice(0, marker);
    } else if (marker < 0) {
      const head = segments[0]?.toLowerCase();
      if ((head === 'home' || head === 'users') && segments.length > 1) {
        segments.splice(0, Math.min(3, segments.length));
      } else if (segments.length > 1) {
        segments.shift();
      }
    }
  }

  const path = segments.join('/');
  return path.length > 0 ? path : null;
}

function parseDetail(detail: FileEvidenceInput['detail']): Record<string, unknown> | null {
  const direct = asRecord(detail);
  if (direct) return direct;
  if (typeof detail !== 'string' || !detail.trim()) return null;
  try {
    return asRecord(JSON.parse(detail));
  } catch {
    // A partial JSON snapshot is not a path. Reject the call whole.
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function commandText(detail: FileEvidenceInput['detail']): string | null {
  const record = parseDetail(detail);
  if (record) {
    const command = record.command ?? record.cmd ?? record.arguments;
    if (typeof command === 'string' && command.trim()) return command;
    if (Array.isArray(command)) {
      const parts = command.filter((part): part is string => typeof part === 'string');
      if (parts.length > 0) return parts.join(' ');
    }
    return null;
  }
  if (typeof detail !== 'string' || !detail.trim()) return null;
  const raw = detail.trim();
  if (raw.startsWith('[')) {
    // A complete JSON argv array is a command; a truncated one is not.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const parts = parsed.filter((part): part is string => typeof part === 'string');
        if (parts.length > 0) return parts.join(' ');
      }
    } catch {
      return null;
    }
    return null;
  }
  // A string that starts like JSON but did not parse is a truncated snapshot,
  // not a command. Never scan a half path out of it.
  if (raw.startsWith('{') || raw.startsWith('"')) return null;
  // Codex `item.command` can arrive as the bare command string.
  return raw;
}

function redirectedPaths(command: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  REDIRECTION.lastIndex = 0;
  let match = REDIRECTION.exec(command);
  while (match) {
    const target = match[1];
    if (target) {
      const unquoted = target.replace(/^(['"])(.*)\1$/, '$2');
      if (!unquoted.startsWith('&') && !unquoted.startsWith('-') && unquoted !== '/dev/null') {
        const path = normalizePath(unquoted);
        if (path && !seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
    }
    match = REDIRECTION.exec(command);
  }
  REDIRECTION.lastIndex = 0;
  return paths;
}

function backendFamily(backend: string): 'claude' | 'codex' | 'opencode' | null {
  const value = backend.toLowerCase();
  if (value.includes('claude')) return 'claude';
  if (value.includes('codex')) return 'codex';
  if (value.includes('opencode')) return 'opencode';
  return null;
}

/**
 * Read one tool call for file evidence (design section 5, item 1).
 *
 * Claude `Write`/`Edit` name `file_path`; OpenCode `edit`/`write` name
 * `filePath`; Codex `exec` is scanned for a shell redirection and is only ever
 * weak. Read-like calls, an unparsed (truncated) snapshot, and every tool we do
 * not recognise return no paths: a missing row is recoverable, a wrong one is
 * not.
 */
export function extractFileEvidence(input: FileEvidenceInput): FileEvidence {
  const family = backendFamily(input.backend);
  const name = input.name.toLowerCase();

  if (family === 'claude' && CLAUDE_WRITE_TOOLS.has(name)) {
    const path = stringField(parseDetail(input.detail), ['file_path', 'path', 'notebook_path']);
    const normalized = normalizePath(path);
    return normalized
      ? { paths: [normalized], kind: 'write', confidence: 'strong' }
      : emptyEvidence();
  }

  if (family === 'opencode' && OPENCODE_WRITE_TOOLS.has(name)) {
    const record = parseDetail(input.detail);
    const path = stringField(record, ['filePath', 'file_path', 'path']);
    const normalized = normalizePath(path);
    return normalized
      ? { paths: [normalized], kind: 'write', confidence: 'strong' }
      : emptyEvidence();
  }

  if (family === 'codex' && CODEX_COMMAND_TOOLS.has(name)) {
    const command = commandText(input.detail);
    const paths = command ? redirectedPaths(command) : [];
    return paths.length > 0
      ? { paths, kind: 'write', confidence: 'weak' }
      : emptyEvidence();
  }

  // Claude Bash is deliberately absent: `cat`/`grep`/`sed` in a shell can read
  // as easily as write, and the design only grants Codex a weak redirection row.
  return emptyEvidence();
}

/**
 * The journal window for one turn (design section 2).
 *
 * `finishedAt` wins; a running turn ends at `updatedAt`; a frame earlier than
 * `startedAt` is clamped to it. No timestamps anywhere means no window at all,
 * so the caller shows nothing rather than a guessed period. Replayed frames
 * only widen the same min/max, so a reconnect still yields one window.
 */
export function boundTurn(input: {
  messages: readonly Pick<ChatMessage, 'turnId' | 'timestamp'>[];
  journalMeta?: TurnJournalMeta | null;
}): BoundTurnWindow | null {
  const meta = input.journalMeta ?? null;
  let turnId = typeof meta?.turnId === 'string' && meta.turnId ? meta.turnId : undefined;
  if (!turnId) {
    for (let index = input.messages.length - 1; index >= 0; index -= 1) {
      const candidate = input.messages[index]?.turnId;
      if (typeof candidate === 'string' && candidate) {
        turnId = candidate;
        break;
      }
    }
  }
  if (!turnId) return null;

  let firstFrame: number | undefined;
  let lastFrame: number | undefined;
  for (const message of input.messages) {
    if (message.turnId !== turnId || !isFiniteNumber(message.timestamp)) continue;
    if (firstFrame === undefined || message.timestamp < firstFrame) firstFrame = message.timestamp;
    if (lastFrame === undefined || message.timestamp > lastFrame) lastFrame = message.timestamp;
  }

  const metaStartedAt = meta && isFiniteNumber(meta.startedAt) ? meta.startedAt : undefined;
  const startedAt = metaStartedAt ?? firstFrame;
  if (startedAt === undefined) return null;

  const metaFinishedAt = meta && isFiniteNumber(meta.finishedAt) ? meta.finishedAt : undefined;
  const metaUpdatedAt = meta && isFiniteNumber(meta.updatedAt) ? meta.updatedAt : undefined;
  const endedAt = metaFinishedAt
    ?? (meta?.status === 'running' ? metaUpdatedAt : metaUpdatedAt ?? lastFrame)
    ?? lastFrame;
  if (endedAt === undefined) return null;

  return { turnId, startedAt, endedAt: Math.max(startedAt, endedAt) };
}

function diffRowMap(rows: readonly TurnDiffRow[] | null | undefined): Map<string, TurnDiffRow> {
  const map = new Map<string, TurnDiffRow>();
  for (const row of rows ?? []) {
    const path = normalizePath(row?.path);
    if (!path) continue;
    map.set(path, row);
  }
  return map;
}

function diffRowChanged(before: TurnDiffRow, after: TurnDiffRow): boolean {
  return before.status !== after.status
    || before.additions !== after.additions
    || before.deletions !== after.deletions
    || (before.patch ?? '') !== (after.patch ?? '');
}

function diffStatus(status: unknown): TurnChangeStatus {
  if (status === 'added' || status === 'modified' || status === 'deleted') return status;
  return 'unknown';
}

function countValue(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? value : undefined;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fold observations and an OpenCode before/after diff into one record
 * (design section 5, item 3).
 *
 * - A path named by a write-like call *and* moved in the diff is `'diff'`
 *   evidence with the diff's counts.
 * - A path only the diff moved is still a `'diff'` row, with no `callIds`: it
 *   changed during the turn, not necessarily by it.
 * - A path only a call named is `'tool'`, status `'unknown'`, no counts.
 * - Without a pre-snapshot nothing is attributed: every row stays tool-only.
 * - A rename becomes a delete plus an add. Rows are sorted by path and call
 *   ids are sorted, so replaying the same input twice is byte-identical.
 */
export function mergeTurnEvidence(
  observations: TurnObservations,
  diffBefore?: readonly TurnDiffRow[] | null,
  diffAfter?: readonly TurnDiffRow[] | null,
): TurnChangeRecord {
  const toolPaths = new Map<string, Set<string>>();
  for (const item of observations.items) {
    if (item.kind !== 'write' || item.confidence === 'none') continue;
    const path = normalizePath(item.path);
    if (!path) continue;
    const ids = toolPaths.get(path) ?? new Set<string>();
    if (typeof item.callId === 'string' && item.callId) ids.add(item.callId);
    toolPaths.set(path, ids);
  }

  const callIdsFor = (path: string): string[] => [...(toolPaths.get(path) ?? [])].sort(compareText);

  const files: TurnChangeFile[] = [];
  const seen = new Set<string>();

  const pushDiff = (path: string, row: TurnDiffRow): void => {
    if (seen.has(path)) return;
    const oldPath = normalizePath(row.oldPath) ?? normalizePath(row.previousPath);
    const renamed = row.status === 'renamed' || (oldPath !== null && oldPath !== path);
    if (renamed && oldPath && oldPath !== path && !seen.has(oldPath)) {
      files.push({
        path: oldPath,
        status: 'deleted',
        evidence: 'diff',
        callIds: callIdsFor(oldPath),
      });
      seen.add(oldPath);
    }
    const additions = countValue(row.additions);
    const deletions = countValue(row.deletions);
    files.push({
      path,
      status: renamed ? 'added' : diffStatus(row.status),
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
      evidence: 'diff',
      callIds: callIdsFor(path),
    });
    seen.add(path);
  };

  // A pre-snapshot is the licence to attribute a diff row to this window.
  if (Array.isArray(diffBefore) && Array.isArray(diffAfter)) {
    const beforeMap = diffRowMap(diffBefore);
    const afterMap = diffRowMap(diffAfter);

    for (const [path, afterRow] of afterMap) {
      const beforeRow = beforeMap.get(path);
      if (!beforeRow || diffRowChanged(beforeRow, afterRow)) pushDiff(path, afterRow);
    }
    for (const path of beforeMap.keys()) {
      if (afterMap.has(path) || seen.has(path)) continue;
      files.push({
        path,
        status: 'deleted',
        evidence: 'diff',
        callIds: callIdsFor(path),
      });
      seen.add(path);
    }
  }

  for (const [path] of toolPaths) {
    if (seen.has(path)) continue;
    files.push({
      path,
      status: 'unknown',
      evidence: 'tool',
      callIds: callIdsFor(path),
    });
    seen.add(path);
  }

  files.sort((a, b) => compareText(a.path, b.path));

  let firstSeen: number | undefined;
  let lastSeen: number | undefined;
  for (const item of observations.items) {
    if (!isFiniteNumber(item.seenAt)) continue;
    if (firstSeen === undefined || item.seenAt < firstSeen) firstSeen = item.seenAt;
    if (lastSeen === undefined || item.seenAt > lastSeen) lastSeen = item.seenAt;
  }
  const startedAt = isFiniteNumber(observations.startedAt) ? observations.startedAt : firstSeen ?? 0;
  const proposedEnd = isFiniteNumber(observations.endedAt) ? observations.endedAt : lastSeen ?? startedAt;

  return {
    v: 1,
    turnId: observations.turnId,
    sessionId: observations.sessionId,
    backendId: observations.backendId,
    startedAt,
    endedAt: Math.max(startedAt, proposedEnd),
    files,
    truncated: false,
    omitted: 0,
  };
}

function cloneFile(file: TurnChangeFile): TurnChangeFile {
  const additions = countValue(file.additions);
  const deletions = countValue(file.deletions);
  return {
    path: file.path,
    status: file.status,
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    evidence: file.evidence,
    callIds: [...file.callIds].sort(compareText),
  };
}

/**
 * Enforce the record caps (design sections 3 and 5, item 4).
 *
 * Files are sorted by path first, so truncation is deterministic. A path over
 * 512 characters is dropped; then the path and byte budgets drop from the end.
 * `omitted` counts every dropped path, and `truncated` says at least one went.
 */
export function capTurnChanges(
  record: TurnChangeRecord,
  caps: TurnChangeCaps = {},
): TurnChangeRecord {
  const maxPaths = isFiniteNumber(caps.maxPaths) && caps.maxPaths >= 0
    ? Math.floor(caps.maxPaths)
    : DEFAULT_TURN_CHANGE_MAX_PATHS;
  const maxBytes = isFiniteNumber(caps.maxBytes) && caps.maxBytes >= 0
    ? Math.floor(caps.maxBytes)
    : DEFAULT_TURN_CHANGE_MAX_BYTES;

  const sorted = [...record.files].sort((a, b) => compareText(a.path, b.path));
  const kept: TurnChangeFile[] = [];
  let dropped = 0;
  for (const file of sorted) {
    if (file.path.length > TURN_CHANGE_MAX_PATH_CHARS) {
      dropped += 1;
      continue;
    }
    kept.push(cloneFile(file));
  }
  while (kept.length > maxPaths) {
    kept.pop();
    dropped += 1;
  }

  let candidate: TurnChangeRecord = {
    ...record,
    files: kept,
    truncated: record.truncated || dropped > 0,
    omitted: record.omitted + dropped,
  };

  while (kept.length > 0 && utf8Bytes(serializeTurnChangeRecord(candidate)) > maxBytes) {
    kept.pop();
    dropped += 1;
    candidate = {
      ...candidate,
      files: kept,
      truncated: true,
      omitted: record.omitted + dropped,
    };
  }

  return candidate;
}

/** Byte length of the UTF-8 encoding, so a cap on bytes counts é as two. */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Serialise a record through an explicit whitelist.
 *
 * The object is rebuilt field by field, so a caller that bolts `content`,
 * `patch`, `detail` or `output` onto a record cannot get it into storage. Key
 * order is fixed, which also gives replay its byte-identical comparison.
 */
export function serializeTurnChangeRecord(record: TurnChangeRecord): string {
  return JSON.stringify({
    v: 1,
    turnId: record.turnId,
    sessionId: record.sessionId,
    backendId: record.backendId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    files: record.files.map((file) => {
      const additions = countValue(file.additions);
      const deletions = countValue(file.deletions);
      return {
        path: file.path,
        status: file.status,
        ...(additions !== undefined ? { additions } : {}),
        ...(deletions !== undefined ? { deletions } : {}),
        evidence: file.evidence,
        callIds: [...file.callIds],
      };
    }),
    truncated: Boolean(record.truncated),
    omitted: countValue(record.omitted) ?? 0,
  });
}

const TURN_CHANGE_STATUSES = new Set<TurnChangeStatus>(['added', 'modified', 'deleted', 'unknown']);
const TURN_CHANGE_EVIDENCES = new Set<TurnChangeEvidence>(['diff', 'tool']);

/**
 * Parse a stored record, or `null` when it is corrupt or the schema moved on.
 * Only whitelisted keys survive; an older/foreign record never becomes a guess.
 */
export function parseTurnChangeRecord(raw: unknown): TurnChangeRecord | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const record = asRecord(value);
  if (!record || record.v !== 1) return null;
  const { turnId, sessionId, backendId, startedAt, endedAt, truncated, omitted } = record;
  if (typeof turnId !== 'string' || typeof sessionId !== 'string'
    || typeof backendId !== 'string') return null;
  if (!isFiniteNumber(startedAt) || !isFiniteNumber(endedAt)) return null;
  const rawFiles = record.files;
  if (!Array.isArray(rawFiles)) return null;
  if (typeof truncated !== 'boolean') return null;
  if (!isFiniteNumber(omitted) || omitted < 0) return null;

  const files: TurnChangeFile[] = [];
  for (const entry of rawFiles) {
    const file = asRecord(entry);
    if (!file) return null;
    if (typeof file.path !== 'string' || !file.path) return null;
    if (typeof file.status !== 'string'
      || !TURN_CHANGE_STATUSES.has(file.status as TurnChangeStatus)) return null;
    if (typeof file.evidence !== 'string'
      || !TURN_CHANGE_EVIDENCES.has(file.evidence as TurnChangeEvidence)) return null;
    if (!Array.isArray(file.callIds)
      || file.callIds.some((id: unknown) => typeof id !== 'string')) return null;
    const additions = countValue(file.additions);
    const deletions = countValue(file.deletions);
    files.push({
      path: file.path,
      status: file.status as TurnChangeStatus,
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
      evidence: file.evidence as TurnChangeEvidence,
      callIds: [...file.callIds],
    });
  }

  return {
    v: 1,
    turnId,
    sessionId,
    backendId,
    startedAt,
    endedAt,
    files,
    truncated,
    omitted,
  };
}

function fileCount(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

/**
 * One quiet line under the bubble (design sections 4 and 5, item 5).
 *
 * "changed" and counts appear only for diff evidence; a diff without counts is
 * "Diff too large"; tool-only evidence is "touched". `+0 −0` is never printed,
 * and a turn with no write-like call returns `null` so the thread shows no row
 * at all — absence is not a zero.
 */
export function toTurnChangeSummary(record: TurnChangeRecord): TurnChangeSummary | null {
  if (record.files.length === 0) return null;

  const diffFiles = record.files.filter((file) => file.evidence === 'diff');
  const toolFiles = record.files.filter((file) => file.evidence === 'tool');
  // A delete legitimately carries no counts; only an added/modified diff row
  // without counts is the "diff too large" case.
  const counted = diffFiles.filter(
    (file) => file.status === 'deleted'
      || isFiniteNumber(file.additions)
      || isFiniteNumber(file.deletions),
  );

  const parts: string[] = [];
  let tone: TurnChangeSummary['tone'] = 'neutral';

  if (diffFiles.length > 0) {
    if (counted.length === 0) {
      parts.push('Diff too large');
      tone = 'warning';
    } else {
      parts.push(`${fileCount(diffFiles.length)} changed`);
      const additions = counted.reduce((total, file) => total + (file.additions ?? 0), 0);
      const deletions = counted.reduce((total, file) => total + (file.deletions ?? 0), 0);
      if (additions + deletions > 0) parts.push(`+${additions} \u2212${deletions}`);
      if (counted.length < diffFiles.length) {
        parts.push('Diff too large');
        tone = 'warning';
      }
    }
  }

  if (toolFiles.length > 0) parts.push(`${fileCount(toolFiles.length)} touched`);
  if (record.omitted > 0) parts.push(`and ${record.omitted} more`);

  return { label: parts.join(' \u00b7 '), tone };
}

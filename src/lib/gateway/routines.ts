import { cronJobSummary } from './cron';
import { formatRunFailure } from './run-failures';

export function routineName(botId: string, title: string): string {
  const trimmed = title.trim();
  return `[bot:${botId}] ${trimmed}`;
}

export function parseRoutineName(name: string): { botId?: string; title: string } {
  const match = /^\[bot:([^\]]+)\]\s*(.*)$/.exec(name ?? '');
  if (!match) return { title: name ?? '' };
  return { botId: match[1], title: match[2] };
}

export type RoutineDraft = {
  title: string;
  prompt: string;
  schedule: string;
};

export const DEFAULT_ROUTINE_SCHEDULE = '0 9 * * *';

/**
 * Operator-facing text for a refused routine create, run, or pause. A
 * failure the run-failure classifiers know renders the same verdict + fix
 * every other surface shows; anything unclassifiable stays the raw message
 * — a misfire can only cost us the nicer wording, never the truth.
 */
export function describeRoutineError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return formatRunFailure(message) ?? message;
}

/**
 * After a create attempt: only a successful create may empty the title and
 * prompt. A refusal keeps the submitted fields so the operator can fix and
 * retry, and names why. Schedule stays either way — the pane already kept
 * it on success.
 */
export function applyRoutineCreate(
  submitted: RoutineDraft,
  mutation: { ok: true } | { ok: false; cause: unknown },
): { draft: RoutineDraft; error?: string } {
  if (mutation.ok) {
    return { draft: { title: '', prompt: '', schedule: submitted.schedule } };
  }
  return { draft: submitted, error: describeRoutineError(mutation.cause) };
}

/** One scheduled job the gateway reports for a Bot. */
export type RoutineJob = {
  id: string;
  name?: string;
  paused?: boolean;
  schedule?: string;
  nextRunAt?: string;
  lastStatus?: string;
  running?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringField(record, key)?.trim();
    if (value) return value;
  }
  return undefined;
}

function parsePaused(raw: Record<string, unknown>): boolean | undefined {
  if (raw.paused === true || raw.paused === false) return raw.paused;
  if (raw.enabled === false) return true;
  if (raw.enabled === true) return false;
  if (raw.paused_at || raw.pausedAt) return true;
  return undefined;
}

function parseRunning(raw: Record<string, unknown>): boolean | undefined {
  const execution = raw.latest_execution ?? raw.latestExecution;
  if (!isRecord(execution)) return undefined;
  if (execution.status === 'running') return true;
  if (typeof execution.status === 'string') return false;
  return undefined;
}

/**
 * Parse one job from Hermes GET /api/jobs (snake_case) or a curated
 * camelCase record. Missing schedule / next run / last status stay
 * absent — the subtitle then degrades the way Activity does, never to
 * "active".
 */
export function routineJobFromUnknown(raw: unknown): RoutineJob | null {
  if (!isRecord(raw)) return null;
  const id = (stringField(raw, 'id') ?? '').trim();
  if (!id) return null;
  const job: RoutineJob = { id };
  const name = optionalString(raw, 'name');
  if (name) job.name = name;
  const paused = parsePaused(raw);
  if (paused !== undefined) job.paused = paused;
  const schedule = optionalString(raw, 'schedule');
  if (schedule) job.schedule = schedule;
  const nextRunAt = optionalString(raw, 'nextRunAt', 'next_run_at');
  if (nextRunAt) job.nextRunAt = nextRunAt;
  const lastStatus = optionalString(raw, 'lastStatus', 'last_status');
  if (lastStatus) job.lastStatus = lastStatus;
  const running = parseRunning(raw);
  if (running !== undefined) job.running = running;
  return job;
}

/** Keep parseable jobs from a listJobs array. A non-array is empty, not a guess. */
export function routineJobsFromList(raw: unknown): RoutineJob[] {
  if (!Array.isArray(raw)) return [];
  const jobs: RoutineJob[] = [];
  for (const item of raw) {
    const job = routineJobFromUnknown(item);
    if (job) jobs.push(job);
  }
  return jobs;
}

/** The Activity one-liner: health, then when it next runs. */
export function routineJobSummary(job: RoutineJob, now = Date.now()): string {
  return cronJobSummary(
    {
      id: job.id,
      title: job.name ?? job.id,
      paused: job.paused,
      nextRunAt: job.nextRunAt ?? null,
      lastStatus: job.lastStatus ?? null,
      running: job.running,
    },
    now,
  );
}

/** What one routine-list read produced. */
export type RoutineRead = { ok: true; jobs: RoutineJob[] } | { ok: false };

/**
 * Visible routines after folding a read. Two failures are not the same
 * fact:
 *   - A failed FIRST read claims zero knowledge — not "Routines (0)".
 *   - A failed RE-read keeps the last good list and marks it stale.
 * Only a successful read may clear or replace the list.
 */
export type RoutinesState = {
  jobs: RoutineJob[];
  /** True once a successful read has landed. */
  loaded: boolean;
  failed: boolean;
};

export const EMPTY_ROUTINES: RoutinesState = { jobs: [], loaded: false, failed: false };

export function applyRoutineRead(previous: RoutinesState, read: RoutineRead): RoutinesState {
  if (read.ok) return { jobs: read.jobs, loaded: true, failed: false };
  if (previous.loaded) return { jobs: previous.jobs, loaded: true, failed: true };
  return { jobs: [], loaded: false, failed: true };
}

export function routinesToggleLabel(state: RoutinesState, open: boolean): string {
  if (open) return 'Hide routines';
  if (!state.loaded) return 'Routines';
  return `Routines (${state.jobs.length})`;
}

export function routinesListCopy(state: RoutinesState): string | undefined {
  if (!state.loaded && state.failed) return 'Routines could not be read.';
  if (state.failed) return 'Could not re-read routines — showing the last list.';
  return undefined;
}

/** Max height for the expanded routines list so jobs and the create form scroll in place. */
export const ROUTINES_PANE_MAX_HEIGHT = 280;

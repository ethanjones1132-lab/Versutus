// ─── Cron transparency: what a scheduled job is, and what it just did ──
//
// The Gate joins Hermes' job record, its latest execution, and the sessions its
// runs wrote, then hands the app one shape. Everything here is presentation
// logic over that shape — kept pure so the surfaces stay dumb and testable.
//
// Two rules run through all of it. Absent data reads as UNKNOWN, never as a
// reassuring claim: a gateway that cannot say whether a job succeeded must not
// render as healthy. And a job that is running says so above everything else,
// because that is the one fact that changes what the operator does next.

import { describeRunFailure, type RunFailureView } from '@/lib/gateway/run-failures';
import { parseRoutineName } from '@/lib/gateway/routine-name';

/** One scheduled job, curated by the Gate with its raw record attached. */
export type CronJob = {
  id: string;
  title: string;
  name?: string | null;
  /** The Bot that owns it, from the `[bot:<name>]` convention; null when it belongs to the gateway. */
  botId?: string | null;
  schedule?: string | null;
  scheduleDisplay?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  lastDeliveryError?: string | null;
  failureStreak?: number;
  state?: string | null;
  paused?: boolean;
  pausedReason?: string | null;
  cooldownUntil?: string | null;
  cooldownReason?: string | null;
  model?: string | null;
  provider?: string | null;
  toolsets?: string[];
  workdir?: string | null;
  deliver?: string | null;
  origin?: string | null;
  prompt?: string;
  promptLength?: number;
  running?: boolean;
  latestExecution?: Record<string, unknown> | null;
  /** The untouched host record, so "show raw" can never be a curated lie. */
  raw?: Record<string, unknown>;
};

/** One past or in-flight run of a job. */
export type CronRun = {
  id: string;
  jobId: string;
  at?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  status: 'running' | 'completed';
  turnCount: number;
  error?: string | null;
};

/** One turn inside a run's transcript. */
export type CronTurn = {
  id: string;
  role: string;
  text: string;
  at?: number | null;
  toolName?: string | null;
};

/**
 * The health verdict for a job, in the same vocabulary a failed send gets.
 *
 * A paused job is not unhealthy — it is off, on purpose, and saying "failing"
 * would be a lie. A cooldown is the host throttling itself and outranks the
 * last status, because it is what stops the next run.
 */
export type CronHealth = {
  tone: 'ok' | 'warn' | 'error' | 'off' | 'unknown';
  label: string;
  detail?: string;
};

export function describeCronHealth(job: CronJob): CronHealth {
  if (job.paused) {
    return { tone: 'off', label: 'Paused', detail: job.pausedReason ?? undefined };
  }
  if (job.cooldownReason) {
    return { tone: 'warn', label: 'Cooling down', detail: job.cooldownReason };
  }
  const streak = job.failureStreak ?? 0;
  if (streak > 0) {
    const failure: RunFailureView | null = job.lastError ? describeRunFailure(job.lastError) : null;
    return {
      tone: 'error',
      label: streak === 1 ? 'Last run failed' : `Failing — ${streak} in a row`,
      detail: failure?.next ?? job.lastError ?? undefined,
    };
  }
  if (job.lastDeliveryError) {
    // The work ran; only the delivery failed. Conflating the two would send
    // the operator hunting a bug in the job itself.
    return { tone: 'warn', label: 'Ran, delivery failed', detail: job.lastDeliveryError };
  }
  if (!job.lastStatus) {
    return { tone: 'unknown', label: 'Not run yet' };
  }
  if (job.lastStatus === 'ok') return { tone: 'ok', label: 'ok' };
  return { tone: 'warn', label: job.lastStatus };
}

/**
 * The one-line subtitle for a job row: what it is doing, or when it next will.
 * A running job says so and nothing else — that is the fact that matters.
 */
export function cronJobSummary(job: CronJob, now = Date.now()): string {
  if (job.running) return 'running now';
  const health = describeCronHealth(job);
  const when = job.nextRunAt ? nextRunLabel(job.nextRunAt, now) : null;
  if (health.tone === 'off') return health.label;
  return when ? `${health.label} · next ${when}` : health.label;
}

/**
 * "in 6m", "in 3h", "Tue 07:00" — near things get a countdown because that is
 * what the operator is deciding against; distant ones get a clock time.
 * An unparseable timestamp yields null rather than a wrong promise.
 */
export function nextRunLabel(nextRunAt: string, now = Date.now()): string | null {
  const at = Date.parse(nextRunAt);
  if (!Number.isFinite(at)) return null;
  const deltaMs = at - now;
  if (deltaMs <= 0) return 'due';
  // Below the half-minute mark the minute read rounds to 0 — a job the
  // gateway is about to fire cannot print the contradictory "in 0m".
  if (Math.round(deltaMs / 60_000) < 1) return 'due';
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 12) return `in ${hours}h`;
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * How long a run took, or has been going. Null when the duration cannot be
 * known — no start, or a finished run the host never stamped with an end.
 *
 * Only a live run is measured against the clock. A finished run with no
 * `finishedAt` used to fall back to `now`, so its duration grew on every
 * render: a run that had already ended kept claiming it was still getting
 * longer. Absent end data is UNKNOWN (null, so the row prints no duration),
 * never a fabricated count-up.
 */
export function runElapsedLabel(run: CronRun, now = Date.now()): string | null {
  const started = run.startedAt;
  if (typeof started !== 'number' || !Number.isFinite(started)) return null;
  let end: number;
  if (run.status === 'running') {
    end = now;
  } else {
    const finished = run.finishedAt;
    if (typeof finished !== 'number' || !Number.isFinite(finished)) return null;
    end = finished;
  }
  const seconds = Math.max(0, Math.round((end - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A run is live when the host has not closed it. */
export function isRunLive(run: CronRun): boolean {
  return run.status === 'running';
}

/** Longest failure reason a run row prints before it is cut short. */
export const CRON_RUN_FAILURE_MAX = 120;

/** One run's verdict, in words a row can print without guessing. */
export type CronRunVerdict = {
  tone: 'running' | 'done' | 'failed' | 'unknown';
  /** What the row prints: `running`, `completed`, `failed`, `cancelled`, or the host's own word. */
  label: string;
  /** The host's message, flattened to one bounded line; absent when it wrote none. */
  detail?: string;
};

const RUN_WORD_RUNNING = /^(running|started|in[ _-]?progress|active)$/;
const RUN_WORD_DONE = /^(ok|complete|completed|succeeded|success|done|finished)$/;
const RUN_WORD_CANCELLED = /^(cancel+ed|cancel+ing|aborted|aborting|killed|stopped)$/;
const RUN_WORD_FAILED = /^(fail|failed|failure|error|errored|timeout|timed[ _-]?out)$/;

/**
 * The host's error, flattened to one bounded line. A multi-line message would
 * shove the run history apart, so it is squeezed to a single line; a value that
 * is not a string carries no readable message and answers empty.
 */
function flattenRunFailure(error: CronRun['error']): string {
  if (typeof error !== 'string') return '';
  const flat = error.replace(/\s+/g, ' ').trim();
  return flat.length > CRON_RUN_FAILURE_MAX
    ? `${flat.slice(0, CRON_RUN_FAILURE_MAX - 1)}…`
    : flat;
}

/**
 * What one run was, judged from the host's error first and its status word
 * second.
 *
 * A finished run that carries an error is a FAILURE, never a success: the wire
 * `status` only says the run is closed, and printing the closure as "completed"
 * is exactly the false success this verdict exists to prevent. The same holds
 * for a failure or cancellation word in `status` — the RPC payload is not
 * validated, so a host that reports `failed` (or a word this build has never
 * seen) must not fall through to "completed". An unrecognised word is printed
 * as the host wrote it, because repeating its word is honest and inventing
 * success is not.
 *
 * Only an absent (or whitespace-only) error lets the status word speak.
 */
export function cronRunVerdict(run: CronRun): CronRunVerdict {
  const detail = flattenRunFailure(run.error);
  const wroteError =
    run.error !== null &&
    run.error !== undefined &&
    (typeof run.error === 'string' ? run.error.trim().length > 0 : true);
  // The host that wrote an error failed the run, whatever word it left behind.
  if (wroteError) {
    return detail
      ? { tone: 'failed', label: 'failed', detail }
      : { tone: 'failed', label: 'failed' };
  }

  const status = String(run.status ?? '').trim();
  const word = status.toLowerCase();
  if (RUN_WORD_RUNNING.test(word)) return { tone: 'running', label: 'running' };
  if (RUN_WORD_DONE.test(word)) return { tone: 'done', label: 'completed' };
  if (RUN_WORD_CANCELLED.test(word)) return { tone: 'failed', label: 'cancelled' };
  if (RUN_WORD_FAILED.test(word)) return { tone: 'failed', label: 'failed' };
  return { tone: 'unknown', label: status || 'unknown' };
}

/**
 * The one-line subtitle for a run row: the verdict, then how long it took and
 * how much it did. A failed run leads with its reason (bounded to one line) and
 * drops the counts — the failure is the fact the operator acts on.
 */
export function cronRunSummary(run: CronRun, now = Date.now()): string {
  const verdict = cronRunVerdict(run);
  if (verdict.detail) return `${verdict.label} · ${verdict.detail}`;
  const elapsed = runElapsedLabel(run, now);
  const turns =
    typeof run.turnCount === 'number' && Number.isFinite(run.turnCount)
      ? `${run.turnCount} turns`
      : null;
  return [verdict.label, elapsed, turns].filter((part): part is string => Boolean(part)).join(' · ');
}

/**
 * How stale the on-screen transcript is. The active-run view polls, so it must
 * always be able to say when it last heard from the host — a frozen view that
 * looks live is worse than one that admits it is behind.
 */
export function freshnessLabel(lastPolledAt: number | null, now = Date.now()): string {
  if (!lastPolledAt) return 'not loaded yet';
  const seconds = Math.max(0, Math.round((now - lastPolledAt) / 1000));
  if (seconds <= 2) return 'updated just now';
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `updated ${minutes}m ago`;
}

/** Jobs a running one first, then unhealthy, then by next run. */
export function sortCronJobs(
  jobs: CronJob[],
  now = Date.now(),
  describe: (job: CronJob) => CronHealth = describeCronHealth,
): CronJob[] {
  // The rank (and its next-run timestamp) is judged once per row up front:
  // a comparator that re-derived both sides per comparison charged
  // O(n log n) health verdicts for n well-known rows. The describer is
  // injectable so tests can count the judgments; it defaults to the shipped
  // verdict.
  const rankOf = (job: CronJob) => {
    if (job.running) return 0;
    const tone = describe(job).tone;
    if (tone === 'error') return 1;
    if (tone === 'warn') return 2;
    if (tone === 'off') return 4;
    return 3;
  };
  const keyed = jobs.map((job) => ({
    job,
    rank: rankOf(job),
    next: Date.parse(job.nextRunAt ?? '') || Number.POSITIVE_INFINITY,
  }));
  keyed.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.next !== b.next) return a.next - b.next;
    return a.job.title.localeCompare(b.job.title);
  });
  return keyed.map((entry) => entry.job);
}

/**
 * The scheduled-work list, grouped by the Bot that owns each job: a job whose
 * name carries the `[bot:<name>]` convention (written by `routineName`, read
 * by `parseRoutineName`) groups under that Bot, and every unowned job shares
 * one `null`-keyed gateway group rather than being guessed into some Bot —
 * the same attribution rule `scorecardRoutineHealth` runs, so the Activity
 * section and the scorecards can never attribute one job to two Bots.
 *
 * Group order follows first appearance in the input (a sorted list keeps its
 * worst-first read), and each group keeps its jobs in that order too.
 */
export function groupCronJobsByOwner(
  jobs: readonly CronJob[],
): Map<string | null, CronJob[]> {
  const groups = new Map<string | null, CronJob[]>();
  for (const job of jobs) {
    const parsed = parseRoutineName(job.name ?? '');
    const botId = typeof parsed.botId === 'string' && parsed.botId.length > 0 ? parsed.botId : null;
    const group = groups.get(botId);
    if (group) group.push(job);
    else groups.set(botId, [job]);
  }
  return groups;
}

/**
 * Narrow the scheduled-work list to the jobs whose title carries the query —
 * a case-insensitive substring, the same rule `filterSessions` runs for the
 * session selector so "search" means the same thing on both surfaces.
 *
 * An empty (or whitespace-only) query answers the SAME array reference, so an
 * idle field is a byte-identical no-op: the section renders the list it
 * already held, not a copy of it. A query that matches nothing answers an
 * empty list — the section says nothing rather than pretending every job
 * vanished or every job stayed.
 */
export function filterCronJobsByTitle(
  jobs: readonly CronJob[],
  query: string,
): CronJob[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return jobs as CronJob[];
  return jobs.filter((job) => job.title.toLowerCase().includes(needle));
}

/** How many jobs are running right now — the Activity section's live badge. */
export function runningCount(jobs: CronJob[]): number {
  return jobs.filter((job) => job.running).length;
}

/**
 * The section's own health mix, as one fold of describeCronHealth's verdicts —
 * "2 failing · 1 cooling down · 3 paused · 2 unreported" — or null when every
 * job is ok, so a clean header renders exactly as it did before this fold
 * existed. The still-unknown are NAMED ("unreported"), never dropped or dressed
 * as healthy: absent data is not a reassuring claim.
 */
export function cronListSummaryText(jobs: CronJob[]): string | null {
  const counts = { failing: 0, coolingDown: 0, deliveryFailed: 0, warned: 0, paused: 0, unreported: 0 };
  for (const job of jobs) {
    if (job.running) continue; // running already has the badge; it is not also a health verdict
    const health = describeCronHealth(job);
    if (health.tone === 'error') counts.failing += 1;
    else if (health.tone === 'off') counts.paused += 1;
    else if (health.tone === 'unknown') counts.unreported += 1;
    else if (health.tone === 'warn') {
      // The warn tones are different facts: a cooldown is the host throttling
      // itself, a delivered-anyway failure is delivery — never one bucket.
      if (job.cooldownReason) counts.coolingDown += 1;
      else if (job.lastDeliveryError) counts.deliveryFailed += 1;
      else counts.warned += 1;
    }
  }
  const parts: string[] = [];
  if (counts.failing > 0) parts.push(`${counts.failing} failing`);
  if (counts.coolingDown > 0) parts.push(`${counts.coolingDown} cooling down`);
  if (counts.deliveryFailed > 0) parts.push(`${counts.deliveryFailed} delivery failed`);
  if (counts.warned > 0) parts.push(`${counts.warned} warned`);
  if (counts.paused > 0) parts.push(`${counts.paused} paused`);
  if (counts.unreported > 0) parts.push(`${counts.unreported} unreported`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

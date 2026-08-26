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
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 12) return `in ${hours}h`;
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** How long a run took, or has been going. Null when the host reported no start. */
export function runElapsedLabel(run: CronRun, now = Date.now()): string | null {
  const started = run.startedAt;
  if (typeof started !== 'number' || !Number.isFinite(started)) return null;
  const end = run.status === 'running' ? now : (run.finishedAt ?? now);
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
export function sortCronJobs(jobs: CronJob[], now = Date.now()): CronJob[] {
  const rank = (job: CronJob) => {
    if (job.running) return 0;
    const tone = describeCronHealth(job).tone;
    if (tone === 'error') return 1;
    if (tone === 'warn') return 2;
    if (tone === 'off') return 4;
    return 3;
  };
  return [...jobs].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const aNext = Date.parse(a.nextRunAt ?? '') || Number.POSITIVE_INFINITY;
    const bNext = Date.parse(b.nextRunAt ?? '') || Number.POSITIVE_INFINITY;
    if (aNext !== bNext) return aNext - bNext;
    return a.title.localeCompare(b.title);
  });
}

/** How many jobs are running right now — the Activity section's live badge. */
export function runningCount(jobs: CronJob[]): number {
  return jobs.filter((job) => job.running).length;
}

// ─── The glanceable snapshot ──────────────────────────────────────
// The pure half of the Home widget (FUTURE-ITEMS.md §4): fold the facts this
// client already holds into the one small shape a widget can render, with no
// gateway call and no storage of its own. The write point that keeps it
// current, and the target that draws it, are their own slices.
//
// Three rules run through it, all of them "do not overclaim":
// - `writtenAt` is always present, so a snapshot frozen since the last write
//   can say WHEN it was written instead of reading as live.
// - The one line is a fact this device recorded — a judged run's own summary,
//   or the gateway's own verdict on a routine — never a line composed here.
// - A read that named nothing produces no line at all, rather than "0 runs".

import { describeCronHealth, type CronJob } from '@/lib/gateway/cron';
import { isTerminalRunStatus, type ActivityRun } from '@/lib/gateway/runs';
import type { ConnectionStatus } from '@/lib/gateway/types';

/**
 * The statuses an ActivityRun carries while the work is still this client's
 * business — the Activity tab's own live set (src/app/(tabs)/activity.tsx:107,
 * the same pair run-card.tsx:66 and buildHomeBriefing call live).
 *
 * Deliberately NOT `isTerminalRunStatus`: that regex reads GATEWAY status
 * strings, and an ActivityRun is `unresolved` exactly when the gateway never
 * said a terminal word before this client stopped polling (runs.ts:145-149).
 * The regex answers false for a run that is over.
 */
const IN_FLIGHT_RUN_STATUSES: ReadonlySet<ActivityRun['status']> = new Set([
  'running',
  'waiting-approval',
]);

/**
 * The small shape a widget renders: this client's connection, how much work is
 * in flight, how much of it is blocked on the operator, the newest outcome, and
 * when all of that was true. Nothing here is fetched — it is what the app
 * already knew at `writtenAt`.
 */
export type GlanceableSnapshot = {
  /** The connection state the app last observed. */
  status: ConnectionStatus;
  /** Runs this client is still driving. */
  runsInFlight: number;
  /** In-flight runs stopped on the operator's decision. */
  approvalsPending: number;
  /** Routines whose schedule the gateway has already let slip past. */
  overdueRoutines: number;
  /**
   * Routines whose own health verdict the fold judged `error` — the same
   * `describeCronHealth` rows that pick a verdict result, never a second
   * judgment of them.
   */
  routineAlerts: number;
  /** The newest judged outcome, run or routine, in its own words. */
  lastResult?: string;
  /** When the snapshot was composed — always present, so staleness is sayable. */
  writtenAt: number;
};

/**
 * A cheap equality key over the snapshot's FACTS — everything but `writtenAt`.
 *
 * The write point (gateway-provider.tsx) re-folds the snapshot on every change
 * to the facts it watches, but poll cycles and bookkeeping patches routinely
 * change a run row without moving any fact a widget renders. Composing a
 * signature here — not in the provider — keeps the definition of "the facts
 * the widget renders" beside the fold that produces them: if a fact is added
 * to `GlanceableSnapshot`, its signature belongs here, not in a caller's
 * private list. `writtenAt` is excluded deliberately: it moves on every fold,
 * and the snapshot already says WHEN it was written — that stamp staying put
 * is exactly what a skipped write is honest about.
 */
export function snapshotSignature(snapshot: GlanceableSnapshot): string {
  return JSON.stringify([
    snapshot.status,
    snapshot.runsInFlight,
    snapshot.approvalsPending,
    snapshot.overdueRoutines,
    snapshot.routineAlerts,
    snapshot.lastResult,
  ]);
}

/** What the app holds about a read: its connection, its runs, its routines. */
export type GlanceableFacts = {
  status: ConnectionStatus;
  runs: readonly ActivityRun[];
  routines: readonly CronJob[];
};

/**
 * A judged run's own one line, read the way the Activity tab already reads it:
 * `summary` is the result or error excerpt (runs.ts:56) and run-card shows it
 * for a run that has settled (run-card.tsx:120); the newest event preview
 * stands in only when the gateway sent no summary.
 */
function runResult(run: ActivityRun): string | null {
  const summary = run.summary?.trim();
  if (summary) return summary;
  const preview = run.events[run.events.length - 1]?.preview?.trim();
  return preview ? preview : null;
}

/**
 * The gateway's own judgment of a job, read ONCE per routine and shared
 * between the alert count and the result line: `isError` is the `error` tone
 * (counted as an alert), and `judged` carries the outcome line with the run
 * timestamp it belongs to. `describeCronHealth` is that vocabulary (cron.ts:82)
 * and is imported rather than re-worded here; a job paused on purpose ('off')
 * and one that never ran ('unknown') are states of the JOB, not the outcome of
 * a run, so neither is a result to report — but a job in 'error' tone whose
 * `lastRunAt` does not parse is still counted as an alert, only unreportable
 * as a line. `null` is only the 'off'/'unknown' tones: no alert and no line.
 */
function routineJudgment(
  job: CronJob,
  health: ReturnType<typeof describeCronHealth>,
): { isError: boolean; judged?: { at: number; text: string } } | null {
  if (health.tone === 'off' || health.tone === 'unknown') return null;
  const isError = health.tone === 'error';
  const at = job.lastRunAt ? Date.parse(job.lastRunAt) : Number.NaN;
  if (!Number.isFinite(at)) return { isError };
  return { isError, judged: { at, text: health.label } };
}

/**
 * A stalled routine, judged by the facts the job itself carries: the gateway
 * named a next run (`nextRunAt`) and it is past, while the job is neither
 * running now nor paused on purpose — a paused job is off BY DECISION, so its
 * missed slot is not a stall. The verdict (`describeCronHealth`) is still the
 * routine's own outcome line; this counts the schedule slipping, which no run
 * row ever reports.
 */
function routineOverdue(job: CronJob, now: number): boolean {
  if (job.running || job.paused) return false;
  const next = job.nextRunAt ? Date.parse(job.nextRunAt) : Number.NaN;
  return Number.isFinite(next) && next <= now;
}

/**
 * Fold what the app holds into the widget's snapshot.
 *
 * The approval count is folded from the run rows rather than taken as an
 * argument: a run is the only thing this client can be waiting on, and the
 * provider marks the row `waiting-approval` the moment it asks
 * (gateway-provider.tsx:2243), so a caller cannot hand in a count the rows do
 * not support.
 */
export function glanceableSnapshot(
  facts: GlanceableFacts,
  now: number = Date.now(),
): GlanceableSnapshot {
  let runsInFlight = 0;
  let approvalsPending = 0;
  let overdueRoutines = 0;
  let routineAlerts = 0;
  let newestRun: { at: number; text: string } | null = null;

  for (const run of facts.runs) {
    if (IN_FLIGHT_RUN_STATUSES.has(run.status)) {
      runsInFlight += 1;
      if (run.status === 'waiting-approval') approvalsPending += 1;
      continue;
    }
    // Nothing to report from a run the gateway never judged: `unresolved` is
    // over, but it carries no verdict, and a line here would claim one.
    if (!isTerminalRunStatus(run.status)) continue;
    const text = runResult(run);
    if (!text) continue;
    const at = run.finishedAt ?? run.startedAt;
    if (!newestRun || at > newestRun.at) newestRun = { at, text };
  }

  for (const job of facts.routines) {
    if (routineOverdue(job, now)) overdueRoutines += 1;
    // The health verdict is judged once per routine and shared: the `error`
    // tone is counted as an alert, and the same verdict — never a second
    // judgment — is the result line's own words.
    const judgment = routineJudgment(job, describeCronHealth(job));
    if (!judgment) continue;
    if (judgment.isError) routineAlerts += 1;
    if (!judgment.judged) continue;
    if (!newestRun || judgment.judged.at > newestRun.at) newestRun = judgment.judged;
  }

  return {
    status: facts.status,
    runsInFlight,
    approvalsPending,
    overdueRoutines,
    routineAlerts,
    ...(newestRun ? { lastResult: newestRun.text } : {}),
    writtenAt: now,
  };
}

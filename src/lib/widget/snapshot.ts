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
  /** The newest judged outcome, run or routine, in its own words. */
  lastResult?: string;
  /** When the snapshot was composed — always present, so staleness is sayable. */
  writtenAt: number;
};

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
 * The gateway's own verdict on a job that has actually been judged, with the
 * run it belongs to. `describeCronHealth` is that vocabulary (cron.ts:82) and
 * is imported rather than re-worded here; a job paused on purpose ('off') and
 * one that never ran ('unknown') are states of the JOB, not the outcome of a
 * run, so neither is a result to report.
 */
function routineVerdict(job: CronJob): { at: number; text: string } | null {
  const health = describeCronHealth(job);
  if (health.tone === 'off' || health.tone === 'unknown') return null;
  const at = job.lastRunAt ? Date.parse(job.lastRunAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return { at, text: health.label };
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
    const verdict = routineVerdict(job);
    if (!verdict) continue;
    if (!newestRun || verdict.at > newestRun.at) newestRun = verdict;
  }

  return {
    status: facts.status,
    runsInFlight,
    approvalsPending,
    ...(newestRun ? { lastResult: newestRun.text } : {}),
    writtenAt: now,
  };
}

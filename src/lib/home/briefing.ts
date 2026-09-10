// ─── While-you-were-away selection ────────────────────────────────
// The pure half of the Home digest (FUTURE-ITEMS §1b): fold the persisted
// ActivityRun records and the operator's lastSeenAt stamp into what Home
// should tell them. Deliberately no storage and no UI here — the card
// component reads the stamp and calls this; nothing else is needed to test
// the "what counts as news" rules.
//
// Honesty rules this module enforces:
// - No stamp for the gateway means the digest has no window; it returns
//   null rather than reading everything as news since 1970.
// - A run that never reached a terminal state is "still going" from the
//   operator's point of view, never a finished run.

import type { ActivityRun } from '@/lib/gateway/runs';

export type HomeBriefingFinished = {
  complete: ActivityRun[];
  failed: ActivityRun[];
  unresolved: ActivityRun[];
};

export type HomeBriefing = {
  /** Runs that finished while the operator was away, grouped by fate. */
  finished: HomeBriefingFinished;
  /** Runs still in flight (or awaiting approval) after the away window. */
  live: ActivityRun[];
  /** How many of the live runs are waiting on the operator. */
  pendingApprovals: number;
};

const LIVE_RUN_STATUSES: ReadonlySet<ActivityRun['status']> = new Set([
  'running',
  'waiting-approval',
]);

function terminalFate(status: ActivityRun['status']): keyof HomeBriefingFinished {
  if (status === 'complete') return 'complete';
  // failed and cancelled mean the run is over and did not go well;
  // unresolved means it is over but its fate is unknown — that stays its
  // own group rather than being dressed up as either.
  if (status === 'unresolved') return 'unresolved';
  return 'failed';
}

/**
 * Select what Home should show since the operator's last visit.
 * `now` is injectable for tests; in production a finish timestamp is never
 * trusted past it (an unsettled record may carry a placeholder), so such a
 * run counts as still-live, not as an overdue completion.
 */
export function buildHomeBriefing(
  runs: readonly ActivityRun[],
  lastSeenAt: number | null,
  now: number = Date.now(),
): HomeBriefing | null {
  if (lastSeenAt === null) return null;

  const finished: HomeBriefingFinished = { complete: [], failed: [], unresolved: [] };
  const live: ActivityRun[] = [];
  let pendingApprovals = 0;

  for (const run of runs) {
    const finishedAfterLeave =
      typeof run.finishedAt === 'number' && run.finishedAt > lastSeenAt && run.finishedAt <= now;
    const carriedOver = LIVE_RUN_STATUSES.has(run.status);

    if (carriedOver) {
      if (run.status === 'waiting-approval') pendingApprovals += 1;
      live.push(run);
      continue;
    }
    // A run that was already settled before the operator left (or whose
    // "finish" timestamp lies past now) is not news — omit it entirely
    // rather than showing a stale card or an overdue completion.
    if (!finishedAfterLeave) continue;
    finished[terminalFate(run.status)].push(run);
  }

  for (const group of Object.values(finished)) {
    group.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  }

  return { finished, live, pendingApprovals };
}

// ─── The card's copy ─────────────────────────────────────────────
// Home is a glance, not a report: the summary turns a briefing into the
// few lines the card shows. Kept pure so the wording is testable without a
// renderer, and deliberately never states a result — only counts of runs
// the device recorded and what each one's own status says happened.

export type HomeBriefingSummary = {
  /** Every run that finished during the away window. */
  finishedCount: number;
  /** Runs still alive (or awaiting approval) after the away window. */
  liveCount: number;
  /** True when there is nothing worth telling the operator. */
  isEmpty: boolean;
  /** Short lines, most actionable first. */
  lines: string[];
};

function countRuns(count: number): string {
  return `${count} run${count === 1 ? '' : 's'}`;
}

export function homeBriefingSummary(briefing: HomeBriefing): HomeBriefingSummary {
  const { complete, failed, unresolved } = briefing.finished;
  const finishedCount = complete.length + failed.length + unresolved.length;
  const liveCount = briefing.live.length;
  const stillGoing = liveCount - briefing.pendingApprovals;
  const lines: string[] = [];

  // Approvals first — they are the one thing that cannot wait for the
  // operator to dig through Activity. A waiting-approval run appears once.
  if (briefing.pendingApprovals > 0) {
    lines.push(`${countRuns(briefing.pendingApprovals)} waiting on your approval`);
  }
  if (failed.length > 0) lines.push(`${countRuns(failed.length)} failed`);
  if (unresolved.length > 0) lines.push(`${countRuns(unresolved.length)} ended without a result`);
  if (stillGoing > 0) lines.push(`${countRuns(stillGoing)} still going`);
  if (complete.length > 0) lines.push(`${countRuns(complete.length)} finished`);

  return {
    finishedCount,
    liveCount,
    isEmpty: finishedCount === 0 && liveCount === 0,
    lines,
  };
}

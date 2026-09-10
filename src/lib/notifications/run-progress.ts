// ─── A run's progress notice (FUTURE-ITEMS.md §7) ─────────────────────────
// The pure half of §7's ongoing notice: fold the run row this device already
// holds into the identifier, the copy and the verb that keep ONE notice in step
// with the run. Nothing here posts, schedules, dismisses or channels anything —
// the poster beside the shipped presenters in local.ts is the next slice, and
// it calls this fold.
//
// Honesty rules, all of them §7's own:
// - The identifier is one string per run id, so re-posting it UPDATEs the notice
//   the operator already has instead of stacking a second one (§7's "updated in
//   place by re-posting the same identifier").
// - The copy is composed at write time from what this device saw: how long the
//   run has been watched, the newest step the run stream delivered, and the
//   clock that was true. A killed app freezes the notice, so the last line is
//   that absolute clock — a relative "2m ago" would be composed once and then
//   read as fresh forever.
// - A run that has left flight is RETIRED rather than narrated: the terminal
//   notice is `notifyRunComplete`'s, and this fold authors no second set of
//   words for the same ending.

import { formatClockTime, formatDuration } from '@/lib/format';
import type { ActivityRun } from '@/lib/gateway/runs';
import { RUN_NOTICE_DATA_KIND } from './tap-route';

/**
 * The statuses a run carries while it is still this device's business — the
 * Activity tab's own live pair (src/app/(tabs)/activity.tsx:107, the same two
 * run-card.tsx:66 and `buildGlanceableSnapshot` call live).
 *
 * Deliberately NOT `isTerminalRunStatus`: that regex reads GATEWAY status
 * strings, and an ActivityRun is `unresolved` exactly when the gateway never
 * said a terminal word before this client stopped polling (runs.ts:145-149).
 * The regex answers false for a run that is over, so retiring on it would leave
 * an ongoing notice in the tray for a run nobody is following.
 */
const IN_FLIGHT_RUN_STATUSES: ReadonlySet<ActivityRun['status']> = new Set([
  'running',
  'waiting-approval',
]);

/** The payload a progress notice carries, in the tap router's own run shape. */
export type RunProgressData = {
  kind: typeof RUN_NOTICE_DATA_KIND;
  runId: string;
};

/** The data payload for one run's progress notice, shaped for the tap router. */
export function runProgressNoticeData(runId: string): RunProgressData {
  return { kind: RUN_NOTICE_DATA_KIND, runId };
}

/**
 * The identifier every update of one run's notice is posted under. One string
 * per run id and nothing else — the clock is not part of it, which is the whole
 * reason the next post replaces the notice rather than adding one.
 */
export function runProgressNoticeIdentifier(runId: string): string {
  return `run-progress:${runId}`;
}

/**
 * The body's own lines, on their own.
 *
 * `body` below is these joined and nothing else, so they are phrased here once:
 * a surface with room for one reading rather than three — §7's Live Activity
 * draws the elapsed span in the Dynamic Island, where a three-line body does not
 * fit (`run-activity.ts`) — reads the line instead of re-parsing prose, and a
 * surface that re-words it is a second voice for the same fact.
 */
export type RunProgressLines = {
  /** 'Elapsed 3:42' — how long this device has watched the run, when readable. */
  elapsed?: string;
  /** The newest step the run stream delivered, when it delivered words. */
  step?: string;
  /** 'Last update 14:02' — when all of the above was true, in this clock. */
  updated: string;
};

/**
 * What the poster does with this fold, and the copy when there is any: an
 * `update` is re-posted under `identifier`, over whatever notice is already
 * there; a `retire` carries no title and no body, because a notice that is
 * being rounded off is never drawn again — its ending is `notifyRunComplete`'s.
 */
export type RunProgressNotice =
  | {
      verb: 'update';
      identifier: string;
      title: string;
      body: string;
      lines: RunProgressLines;
      data: RunProgressData;
    }
  | {
      verb: 'retire';
      identifier: string;
      data: RunProgressData;
    };

/**
 * The title, under §7's honesty rule: a title is the one line a locked screen
 * shows, so it names the state the run is in — a run stopped on the operator's
 * decision is not a run in progress.
 */
const RUN_PROGRESS_TITLE = 'Run in progress';
const RUN_APPROVAL_TITLE = 'Run needs approval';

/**
 * Fold one run into the notice that follows it: the identifier every update
 * shares, the body composed from the row this device already holds, and the
 * verb — `update` while the run is in flight, `retire` once it has left it.
 */
export function runProgressNotice(run: ActivityRun, now: number = Date.now()): RunProgressNotice {
  const identifier = runProgressNoticeIdentifier(run.id);
  const data = runProgressNoticeData(run.id);
  if (!IN_FLIGHT_RUN_STATUSES.has(run.status)) return { verb: 'retire', identifier, data };

  const lines = progressLines(run, now);
  return {
    verb: 'update',
    identifier,
    title: run.status === 'waiting-approval' ? RUN_APPROVAL_TITLE : RUN_PROGRESS_TITLE,
    body: progressBody(lines),
    lines,
    data,
  };
}

/**
 * The readings: how long this device has watched the run, the newest step the
 * run stream delivered, and when all of that was true. Every line is a fact
 * about what was read, never a claim about a gateway this app can no longer
 * see.
 */
function progressLines(run: ActivityRun, now: number): RunProgressLines {
  // The span is stated only when it can be read as one: a `startedAt` that is
  // not a finite instant, or one this client would have to read as the future,
  // is no watch length at all — `formatDuration` answers both `0:00`
  // (format.ts:102), which would be an elapsed time nobody measured. The
  // scorecard's `watchedRunSpanMs` refuses a span the same way (scorecard.ts:236-241).
  const elapsed =
    Number.isFinite(run.startedAt) && run.startedAt <= now
      ? `Elapsed ${formatDuration(now - run.startedAt)}`
      : undefined;

  // The row holds the previews the driver already folded with `runEventPreview`
  // (gateway-provider.tsx:2230) and carries no raw event payload, so this reads
  // the newest one and never re-derives one: re-wording it here — or calling
  // that helper on a stored row, whose answer would be its own `'{}'` fallback
  // (runs.ts:91) — would be this fold inventing a step the run never reported.
  // A preview that holds no words is no step either.
  const preview = run.events[run.events.length - 1]?.preview;
  const step = preview && preview.trim() ? preview : undefined;

  return {
    ...(elapsed ? { elapsed } : {}),
    ...(step ? { step } : {}),
    // §7's Constraints: the process can be killed and the notice then freezes, so
    // the copy says when it was written instead of implying it is still moving.
    updated: `Last update ${formatClockTime(now)}`,
  };
}

/** The body the poster draws: the same readings, in the order they were taken. */
function progressBody(lines: RunProgressLines): string {
  return [lines.elapsed, lines.step, lines.updated].filter(Boolean).join('\n');
}

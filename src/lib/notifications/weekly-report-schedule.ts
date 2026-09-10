// ─── Pure decision helpers for the weekly operator report notice ─────────
// D3's weekly report (FUTURE-ITEMS.md §D3 Build 4/5): ONE weekly local
// notice, enabled from the scorecard surface, off by default. Deliberately
// free of expo-notifications side effects (the enum import is only
// constants), so every rule here is jest-pinnable without mocks. The
// side-effecting sibling (`weekly-report.ts`) applies them to the real
// scheduling APIs.
//
// Honesty rule: a scheduled notice fires at its scheduled time whether or
// not the gateway ran, and it cannot know the week's figures while the app is
// closed. So the copy announces a report that is READY and counts nothing —
// no number, no verdict — and the tap opens the surface that computes it
// live. Nothing here is true push; that is Solution A's, still deferred.

import { SchedulableTriggerInputTypes } from 'expo-notifications';

/**
 * Storage key holding the scheduled notice's identifier, so opting out can
 * retire exactly the notice this device scheduled. Named like
 * `versutus:routine-notification:<jobId>` with no id suffix, because the
 * weekly report is one notice for the whole app rather than one per routine.
 */
export const WEEKLY_REPORT_NOTICE_KEY = 'versutus:weekly-report-notification';

/**
 * Storage key holding the opt-in flag. ABSENT means off: D3's "enabled from
 * the scorecard surface, off by default" is one stored state, so a fresh
 * install and an explicit opt-out cannot disagree about what this device
 * holds.
 */
export const WEEKLY_REPORT_OPT_IN_KEY = 'versutus:weekly-report-opt-in';

/** The one stored value that means on. Nothing else — including absent — is. */
export const WEEKLY_REPORT_OPT_IN_ON = 'on';

/** The expo trigger shape a weekly report notice produces. */
export type WeeklyReportTrigger = {
  type: SchedulableTriggerInputTypes.WEEKLY;
  weekday: number;
  hour: number;
  minute: number;
};

/**
 * The weekly fire: Monday 09:00 local — the hour `DEFAULT_ROUTINE_SCHEDULE`
 * uses (`0 9 * * *`), at the start of the operator's week.
 *
 * `weekday: 2` is Monday because expo numbers weekdays 1 (Sunday) through 7
 * (Saturday) — the same mapping `parseDayOfWeek` applies to cron's day field
 * (`routine-schedule.ts`). A fresh object per call: the trigger is handed to
 * the native scheduler, so no two callers share one mutable instance.
 */
export function weeklyReportTrigger(): WeeklyReportTrigger {
  return { type: SchedulableTriggerInputTypes.WEEKLY, weekday: 2, hour: 9, minute: 0 };
}

/** The tray title: the report exists, and that is all a schedule can know. */
export const WEEKLY_REPORT_NOTICE_TITLE = 'Your weekly agent report is ready';

/**
 * The tray body. It names what the tap opens — the runs this device recorded
 * — rather than a result: the report is computed when the operator opens it,
 * and runs started elsewhere never touched this device (D3's Constraints).
 */
export const WEEKLY_REPORT_NOTICE_BODY = 'Open Versutus to see the runs this device recorded.';

/** The opt-in control's label and its one line of explanation. */
export const WEEKLY_REPORT_OPT_IN_LABEL = 'Weekly report';
export const WEEKLY_REPORT_OPT_IN_SUMMARY =
  'One local notice on Monday morning — it fires on schedule whether or not the gateway runs, and the report is computed when you open it.';

/** The on/off decision for one stored flag value; absent is off. */
export function isWeeklyReportEnabled(stored: string | null): boolean {
  return stored === WEEKLY_REPORT_OPT_IN_ON;
}

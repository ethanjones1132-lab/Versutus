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
// live, which is what the notice's one marker (its `kind`) routes. Nothing
// here is true push; that is Solution A's, still deferred.

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

/**
 * data.kind marker the weekly notice carries, so a tap knows it opened the
 * report rather than a run or a routine. It is the whole payload: the tap's
 * destination takes no argument, because the Scorecards section reads the runs
 * this device holds when it opens. When Solution A ships, the Gate's push may
 * add the week's real figures beside this kind (the A5 payload-shape rule);
 * the kind stays the contract that decides the route.
 */
export const WEEKLY_REPORT_NOTICE_DATA_KIND = 'weekly-report';

/** The payload the weekly notice carries, so a tap can route on `kind`. */
export type WeeklyReportNoticeData = {
  kind: typeof WEEKLY_REPORT_NOTICE_DATA_KIND;
};

/** The data payload for the weekly report's notice, shaped for the tap router. */
export function weeklyReportNoticeData(): WeeklyReportNoticeData {
  return { kind: WEEKLY_REPORT_NOTICE_DATA_KIND };
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

/**
 * Why an opt-in that asked for its notice holds none. Both are the device's
 * own refusal rather than the operator's: the phone declined notifications,
 * or the schedule could not be placed. They are named apart because only the
 * first is something the operator can go and change.
 */
export type WeeklyReportRefusal = 'permission' | 'schedule';

/**
 * What this device holds after the opt-in switch was asked to change, and —
 * when it was asked for a notice and holds none — why. A refusal is a state
 * of its own rather than a bare "off", so a surface can tell an operator
 * whose phone said no from one who never turned the report on.
 */
export type WeeklyReportOptInState =
  | { state: 'on' }
  | { state: 'off' }
  | { state: 'refused'; reason: WeeklyReportRefusal };

/** Whether this state means the device holds the notice it asked for. */
export function weeklyReportOptInHolds(state: WeeklyReportOptInState): boolean {
  return state.state === 'on';
}

/** The refusal this state names, or null when the attempt met none. */
export function weeklyReportRefusedBy(state: WeeklyReportOptInState): WeeklyReportRefusal | null {
  return state.state === 'refused' ? state.reason : null;
}

/**
 * The line a refused notification permission shows. It names the one thing the
 * operator can act on and counts nothing, like every other string about this
 * report.
 *
 * It says the report cannot be SHOWN rather than that it could not be
 * scheduled, because the same line covers both ways this device reaches this
 * reason: an attempt the phone declined, which scheduled nothing, and a
 * permission revoked in Settings after the opt-in, where the held notice is
 * still on the OS queue and only the tray's refusal is left to name.
 */
export const WEEKLY_REPORT_PERMISSION_REFUSAL_COPY =
  'Notifications are off for Versutus, so the weekly report cannot be shown — turn them on in Settings.';

/**
 * The line a schedule that could not be placed shows. Deliberately silent
 * about Settings: notifications were granted here, so sending the operator
 * there would send them after nothing.
 */
export const WEEKLY_REPORT_SCHEDULE_REFUSAL_COPY =
  'The report could not be scheduled just now — try the switch again.';

/** The one line a refusal shows — its own reason's words, and nothing else. */
export function weeklyReportRefusalCopy(reason: WeeklyReportRefusal): string {
  return reason === 'permission'
    ? WEEKLY_REPORT_PERMISSION_REFUSAL_COPY
    : WEEKLY_REPORT_SCHEDULE_REFUSAL_COPY;
}

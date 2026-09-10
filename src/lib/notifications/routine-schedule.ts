// ─── Pure decision helpers for scheduled routine notices ─────────────────
// Deliberately free of expo-notifications side effects (the enum import is
// only constants), so every mapping rule is jest-pinnable without mocks.
// The side-effecting module (local.ts) applies these to the real
// scheduling APIs.
//
// Honesty rule (FUTURE-ITEMS.md §1a): a routine notice fires at the
// scheduled time whether or not the gateway actually ran. Copy says "due",
// never a result count.

import { SchedulableTriggerInputTypes } from 'expo-notifications';

/**
 * The expo-notifications trigger shapes a routine can produce. The enum is
 * imported for its constants; nothing here touches the native
 * notification APIs themselves.
 */
export type RoutineTrigger =
  | {
      type: SchedulableTriggerInputTypes.DAILY;
      hour: number;
      minute: number;
    }
  | {
      type: SchedulableTriggerInputTypes.WEEKLY;
      weekday: number;
      hour: number;
      minute: number;
    }
  | {
      type: SchedulableTriggerInputTypes.DATE;
      date: number;
    };

/** data.kind marker that scopes a posted notice to one routine job. */
export const ROUTINE_NOTICE_DATA_KIND = 'routine-due';

/** The payload a routine notice carries, so a tap can route on `kind`. */
export type RoutineNoticeData = {
  kind: typeof ROUTINE_NOTICE_DATA_KIND;
  jobId: string;
  botId: string;
};

/** The data payload for one routine's notice, shaped for the tap router. */
export function routineNoticeData(jobId: string, botId: string): RoutineNoticeData {
  return { kind: ROUTINE_NOTICE_DATA_KIND, jobId, botId };
}

/**
 * Honest tray copy: the notice announces a routine that is DUE at its
 * scheduled time — it must never imply the gateway already ran.
 */
export function routineNoticeTitle(title: string): string {
  const trimmed = title.trim();
  return `${trimmed || 'Routine'} is due`;
}

/**
 * Map a routine's 5-field cron string onto an expo-notifications trigger.
 *
 * Routines live on the gateway as 5-field cron
 * (DEFAULT_ROUTINE_SCHEDULE = '0 9 * * *'). Only the two shapes expo's
 * repeating triggers can express are mapped to them — a fixed daily time
 * (`M H * * *`) and a fixed weekly time (`M H * * D`); everything else
 * falls back to a one-shot DATE built from the next fire the GATEWAY
 * reported. A mis-shaped day field is not a parse failure — it only means
 * the cadence is beyond the repeating shapes. Never evaluate cron locally
 * beyond the two repeating shapes; trust the gateway's `nextRunAt` for the
 * rest, and return null when the gateway has not supplied one (or the cron
 * does not parse as five fields at all).
 */
export function cronToTrigger(
  cron: string,
  nextRunAt?: string,
  now: number = Date.now(),
): RoutineTrigger | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;

  // Day-of-month and day-of-week decide the REPEATING shape; read them
  // before anything else. A populated day field in either position means
  // the routine fires on certain days the repeating triggers cannot
  // express (dual condition, day-of-month, weekday list/range/step) — the
  // one-shot is the honest landing, so mis-shapes there are NOT a parse
  // failure; they just do not map to DAILY/WEEKLY.
  const dayOfMonthAny = isAnyField(dayOfMonthField);
  const dayOfWeek = parseDayOfWeek(dayOfWeekField);

  const minute = parseSingleValue(minuteField, 0, 59);
  const hour = parseSingleValue(hourField, 0, 23);

  // A fixed daily time is mappable only when the day-of-week field is `*`
  // and things the minute/hour shapes are single values. (The dual-day
  // guard is below.)
  if (
    dayOfMonthAny &&
    dayOfWeek === 'any' &&
    minute !== null &&
    hour !== null &&
    isAnyField(monthField)
  ) {
    return { type: SchedulableTriggerInputTypes.DAILY, hour, minute };
  }

  // A single weekday with single-valued minute/hour and every month is the
  // fixed weekly fire.
  if (
    dayOfMonthAny &&
    typeof dayOfWeek === 'number' &&
    minute !== null &&
    hour !== null &&
    isAnyField(monthField)
  ) {
    return { type: SchedulableTriggerInputTypes.WEEKLY, weekday: dayOfWeek, hour, minute };
  }

  // Anything else — day-of-month populated (`0 9 1 * *`), month steps and
  // lists (`0 9 * 1,6 *`), minute/hour steps (`*/5 * * * *`), or weekday
  // ranges (`0 9 * * 1-5`) — is a cadence beyond the two repeating shapes.
  // Do not evaluate cron locally: take the next fire the gateway computed.
  const at = nextRunAt ? Date.parse(nextRunAt) : NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  return { type: SchedulableTriggerInputTypes.DATE, date: at };
}

/**
 * A single in-range number (one concrete value). `*` is NOT single — that
 * is the unconstrained marker, handled separately. Lists, ranges, steps,
 * and out-of-range values return null.
 */
function parseSingleValue(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  if (value < min || value > max) return null;
  return value;
}

/** True for a lone `*` — the unconstrained wildcard. */
function isAnyField(field: string): boolean {
  return field === '*';
}

/**
 * Day-of-week field → expo weekday (1=Sunday..7=Saturday; cron 0 and 7 are
 * both Sunday). `*` returns the 'any' marker; lists, ranges, steps, and
 * out-of-range values return null (not weekly-mappable).
 */
function parseDayOfWeek(field: string): number | 'any' | null {
  if (isAnyField(field)) return 'any';
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  if (value === 7) return 1;
  if (value < 0 || value > 6) return null;
  return value + 1;
}

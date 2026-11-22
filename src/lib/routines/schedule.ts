import { nextRunLabel } from '@/lib/gateway/cron';

export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'every-hours' | 'advanced';

export type ScheduleDraft = {
  preset: SchedulePreset;
  hour: number;
  minute: number;
  weekday: number;
  intervalHours: number;
  cron: string;
};

function validInteger(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function cronFor(draft: ScheduleDraft): string {
  const { hour, minute, weekday, intervalHours, preset } = draft;
  if (preset === 'daily') return `${minute} ${hour} * * *`;
  if (preset === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (preset === 'weekly') return `${minute} ${hour} * * ${weekday}`;
  if (preset === 'every-hours') return `0 */${intervalHours} * * *`;
  return draft.cron;
}

function parseMinuteHour(cron: string): { minute: number; hour: number } | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!validInteger(minute, 0, 59) || !validInteger(hour, 0, 23)) return null;
  return { minute, hour };
}

export function scheduleDraftFromCron(cron: string): ScheduleDraft {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { preset: 'advanced', hour: 9, minute: 0, weekday: 1, intervalHours: 1, cron };
  }
  const [minuteField, hourField, dayField, monthField, weekField] = fields;
  if (minuteField === '0' && dayField === '*' && monthField === '*' && weekField === '*' && /^\*\/\d+$/.test(hourField)) {
    const hours = Number(hourField.slice(2));
    if (validInteger(hours, 1, 24)) {
      return { preset: 'every-hours', hour: 0, minute: 0, weekday: 1, intervalHours: hours, cron };
    }
  }
  const parsed = parseMinuteHour(cron);
  if (!parsed) {
    return { preset: 'advanced', hour: 9, minute: 0, weekday: 1, intervalHours: 1, cron };
  }
  const base = { ...parsed, weekday: 1, intervalHours: 1 };
  if (dayField === '*' && monthField === '*' && weekField === '*') {
    return { ...base, preset: 'daily', cron };
  }
  if (dayField === '*' && monthField === '*' && weekField === '1-5') {
    return { ...base, preset: 'weekdays', cron };
  }
  if (dayField === '*' && monthField === '*' && /^\d$/.test(weekField) && Number(weekField) <= 6) {
    return { ...base, preset: 'weekly', weekday: Number(weekField), cron };
  }
  return { ...base, preset: 'advanced', cron };
}

export function scheduleDraftToCron(draft: ScheduleDraft): string {
  if (
    !validInteger(draft.hour, 0, 23) ||
    !validInteger(draft.minute, 0, 59) ||
    !validInteger(draft.weekday, 0, 6) ||
    !validInteger(draft.intervalHours, 1, 24)
  ) return draft.cron;
  return cronFor(draft);
}

function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  const step = /^(\*|\d+-\d+)\/(\d+)$/.exec(field);
  if (step) {
    const stride = Number(step[2]);
    if (!validInteger(stride, 1, max + 1)) return false;
    if (step[1] === '*') return (value - min) % stride === 0;
    const [start, end] = step[1].split('-').map(Number);
    return value >= start && value <= end && (value - start) % stride === 0;
  }
  return field.split(',').some((part) => {
    if (/^\d+-\d+$/.test(part)) {
      const [start, end] = part.split('-').map(Number);
      return value >= start && value <= end;
    }
    return /^\d+$/.test(part) && Number(part) === value;
  });
}

export function nextCronRun(cron: string, after = new Date()): Date | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const end = candidate.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= end) {
    const day = candidate.getDay();
    // Cron day-of-month and day-of-week are ORed when both are restricted.
    const dom = cronFieldMatches(fields[2], candidate.getDate(), 1, 31);
    const dow = cronFieldMatches(fields[4], day, 0, 6);
    const dayMatches = fields[2] === '*' ? dow : fields[4] === '*' ? dom : dom || dow;
    if (
      cronFieldMatches(fields[0], candidate.getMinutes(), 0, 59) &&
      cronFieldMatches(fields[1], candidate.getHours(), 0, 23) &&
      dayMatches &&
      cronFieldMatches(fields[3], candidate.getMonth() + 1, 1, 12)
    ) return new Date(candidate);
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

export function formatScheduleTime(hour: number, minute: number, hour12 = false): string {
  const date = new Date(2000, 0, 1, hour, minute);
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12,
  });
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function describeSchedule(cron: string, hour12 = false): string {
  const draft = scheduleDraftFromCron(cron);
  const time = formatScheduleTime(draft.hour, draft.minute, hour12);
  let description: string;
  switch (draft.preset) {
    case 'daily': description = `Every day at ${time}`; break;
    case 'weekdays': description = `Weekdays at ${time}`; break;
    case 'weekly': description = `Every week on ${WEEKDAYS[draft.weekday]} at ${time}`; break;
    case 'every-hours': description = `Every ${draft.intervalHours} hours`; break;
    case 'advanced': description = `Advanced schedule (${cron})`; break;
  }
  return description;
}

export function schedulePreview(cron: string, now = new Date(), hour12 = false): { description: string; nextRun: string } {
  const next = nextCronRun(cron, now);
  return {
    description: describeSchedule(cron, hour12),
    nextRun: nextRunLabel(next?.toISOString() ?? '', now.getTime()) ?? 'No upcoming run found',
  };
}

/** A clock time on the phone's own wall clock, in the app's 24-hour style. */
function localClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function localDayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

/**
 * The next run as the phone's local clock reads it: "today at 09:00",
 * "tomorrow at 09:00", "Monday at 09:30", or a dated form further out.
 *
 * A route timestamp is UTC on the wire; a phone operator should never have to
 * convert it in their head, so this always speaks the phone's own time. Null
 * when the timestamp cannot be parsed — no invented promise.
 */
export function localRunTimeLabel(nextRunAt: string | null | undefined, now = Date.now()): string | null {
  const at = Date.parse(nextRunAt ?? '');
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  const today = new Date(now);
  // Rounding absorbs the 23/25-hour days around a daylight-saving change.
  const days = Math.round((localDayStart(date) - localDayStart(today)) / 86_400_000);
  const time = localClock(date);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[date.getDay()]} at ${time}`;
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()} at ${time}`;
}

/** One routine's schedule as the detail sheet should read it. */
export type RoutineScheduleView = {
  /** The schedule in words; never a bare cron expression when it can be read. */
  description: string | null;
  /** The next run on the phone's clock, or null when no run can be named. */
  nextRun: string | null;
};

/** Does this string look like the five-field expression itself, not words? */
function looksLikeCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[\d*/,-]+$/.test(field));
}

/**
 * The schedule and next run one routine detail row can print.
 *
 * The host's own `scheduleDisplay` wins when it sent one — it knows the
 * schedule's timezone. Otherwise a readable cron is spoken in words by the
 * same preview the picker uses, so a daily routine never shows `0 9 * * *`.
 * A host that has not reported a next run for a preset schedule still lets the
 * phone derive one, under the same local-time rule the picker creates with.
 */
export function routineScheduleView(
  job: { schedule?: string | null; scheduleDisplay?: string | null; nextRunAt?: string | null },
  now = new Date(),
): RoutineScheduleView {
  const cron = job.schedule?.trim() ?? '';
  const display = job.scheduleDisplay?.trim() ?? '';
  // A display that is the expression again is not words; describe it instead.
  const hostWords = display && !looksLikeCron(display) ? display : '';
  const expression = cron || (looksLikeCron(display) ? display : '');
  const description = hostWords || (expression ? describeSchedule(expression) : null);
  const confirmed = localRunTimeLabel(job.nextRunAt, now.getTime());
  // Only a preset schedule is cheap enough to derive minute-by-minute, and an
  // advanced expression the host did not report a next run for stays unknown
  // rather than guessed.
  const derived =
    !confirmed && expression && scheduleDraftFromCron(expression).preset !== 'advanced'
      ? nextCronRun(expression, now)
      : null;
  return {
    description,
    nextRun: confirmed ?? (derived ? localRunTimeLabel(derived.toISOString(), now.getTime()) : null),
  };
}

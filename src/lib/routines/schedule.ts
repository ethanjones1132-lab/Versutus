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

export function schedulePreview(cron: string, now = new Date(), hour12 = false): { description: string; nextRun: string } {
  const draft = scheduleDraftFromCron(cron);
  const time = formatScheduleTime(draft.hour, draft.minute, hour12);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let description: string;
  switch (draft.preset) {
    case 'daily': description = `Every day at ${time}`; break;
    case 'weekdays': description = `Weekdays at ${time}`; break;
    case 'weekly': description = `Every week on ${days[draft.weekday]} at ${time}`; break;
    case 'every-hours': description = `Every ${draft.intervalHours} hours`; break;
    case 'advanced': description = `Advanced schedule (${cron})`; break;
  }
  const next = nextCronRun(cron, now);
  return {
    description,
    nextRun: nextRunLabel(next?.toISOString() ?? '', now.getTime()) ?? 'No upcoming run found',
  };
}

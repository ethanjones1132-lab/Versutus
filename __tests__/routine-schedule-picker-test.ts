import {
  formatScheduleTime,
  nextCronRun,
  scheduleDraftFromCron,
  scheduleDraftToCron,
  schedulePreview,
} from '@/lib/routines/schedule';
import { nextRunLabel } from '@/lib/gateway/cron';

test.each([
  ['0 9 * * *', 'daily'],
  ['30 8 * * 1-5', 'weekdays'],
  ['15 17 * * 5', 'weekly'],
  ['0 */3 * * *', 'every-hours'],
] as const)('cron %s reopens in the %s preset and round-trips', (cron, preset) => {
  const draft = scheduleDraftFromCron(cron);
  expect(draft.preset).toBe(preset);
  expect(scheduleDraftToCron(draft)).toBe(cron);
});

test('non-preset cron reopens as Advanced and remains unchanged', () => {
  const cron = '5 1,13 * * 1-5';
  expect(scheduleDraftFromCron(cron).preset).toBe('advanced');
  expect(scheduleDraftToCron(scheduleDraftFromCron(cron))).toBe(cron);
});

test('time formatting supports both 12- and 24-hour clocks, including midnight', () => {
  expect(formatScheduleTime(0, 5, false)).toBe('00:05');
  expect(formatScheduleTime(0, 5, true)).toMatch(/12:05/);
  expect(formatScheduleTime(13, 5, false)).toBe('13:05');
  expect(formatScheduleTime(13, 5, true)).toMatch(/1:05/);
  expect(schedulePreview('5 13 * * *', new Date(2026, 0, 5, 8, 0), false).description).toContain('13:05');
  expect(schedulePreview('5 13 * * *', new Date(2026, 0, 5, 8, 0), true).description).toMatch(/1:05/);
});

test('schedule preview names preset and next run, including an every-hours interval', () => {
  const now = new Date(2026, 0, 5, 8, 59);
  const daily = schedulePreview('0 9 * * *', now);
  expect(daily.description).toMatch(/^Every day at /);
  expect(daily.nextRun).toBe(nextRunLabel(nextCronRun('0 9 * * *', now)!.toISOString(), now.getTime()));
  expect(schedulePreview('0 */2 * * *', now).description).toBe('Every 2 hours');
  expect(nextCronRun('0 */2 * * *', now)?.getHours()).toBe(10);
});

test('an Advanced preview keeps the cron visible and still names the next run', () => {
  const cron = '5 1,13 * * 1-5';
  const now = new Date(2026, 0, 5, 0, 0);
  const preview = schedulePreview(cron, now);
  expect(preview.description).toBe(`Advanced schedule (${cron})`);
  expect(preview.nextRun).toBe(nextRunLabel(nextCronRun(cron, now)!.toISOString(), now.getTime()));
});

test('next-run preview handles midnight and weekly schedules in local time', () => {
  const beforeMidnight = new Date(2026, 0, 5, 23, 59);
  const midnight = nextCronRun('0 0 * * *', beforeMidnight);
  expect(midnight?.getDate()).toBe(6);
  expect(midnight?.getHours()).toBe(0);
  expect(nextCronRun('0 9 * * 1', new Date(2026, 0, 5, 9, 0))?.getDate()).toBe(12);
});

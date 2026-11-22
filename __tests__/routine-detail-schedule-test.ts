// VS-136: the routine detail sheet speaks the schedule in words and prints
// the next run on the phone's own clock. These are the pure rules that sheet
// renders, pinned away from the raw cron expression and the wire's UTC ISO.
import {
  describeSchedule,
  formatScheduleTime,
  localRunTimeLabel,
  routineScheduleView,
} from '@/lib/routines/schedule';

const NOW = new Date(2026, 10, 19, 8, 0, 0); // Thu 19 Nov 2026, 08:00 local
const NINE = formatScheduleTime(9, 0, false);

test('a daily cron reads in words, never as the bare expression', () => {
  const view = routineScheduleView({ schedule: '0 9 * * *' }, NOW);

  expect(view.description).toBe(`Every day at ${NINE}`);
  expect(view.description).not.toContain('0 9 * * *');
  expect(describeSchedule('0 9 * * *')).toBe(`Every day at ${NINE}`);
});

test('the host timestamp prints on the phone clock, never as ISO', () => {
  const nextRunAt = new Date(2026, 10, 19, 9, 0, 0).toISOString();
  const view = routineScheduleView({ schedule: '0 9 * * *', nextRunAt }, NOW);

  expect(view.nextRun).toBe('today at 09:00');
  expect(view.nextRun).not.toContain('T');
  expect(view.nextRun).not.toContain('Z');
  expect(view.nextRun).not.toContain(nextRunAt);
});

test('a missing next run is derived from the schedule in local time', () => {
  const view = routineScheduleView({ schedule: '0 9 * * *' }, NOW);

  expect(view.nextRun).toBe('today at 09:00');
});

test('later runs name their day instead of a bare offset', () => {
  const tomorrow = new Date(2026, 10, 20, 9, 0, 0).toISOString();
  const later = new Date(2026, 10, 23, 9, 0, 0).toISOString(); // Monday

  expect(localRunTimeLabel(tomorrow, NOW.getTime())).toBe('tomorrow at 09:00');
  expect(localRunTimeLabel(later, NOW.getTime())).toBe('Monday at 09:00');
  expect(localRunTimeLabel('not a timestamp', NOW.getTime())).toBeNull();
});

test('a run more than a week out is dated, still on the phone clock', () => {
  const far = new Date(2026, 11, 25, 9, 0, 0).toISOString(); // Friday 25 Dec

  expect(localRunTimeLabel(far, NOW.getTime())).toBe('Friday Dec 25 at 09:00');
});

test('the host display string wins when the host sent one', () => {
  const view = routineScheduleView(
    { schedule: '0 9 * * *', scheduleDisplay: 'Every day at 9:00 AM UTC' },
    NOW,
  );

  expect(view.description).toBe('Every day at 9:00 AM UTC');
});

test('a display that is the bare expression again is still spoken in words', () => {
  const view = routineScheduleView(
    { schedule: '0 9 * * *', scheduleDisplay: '0 9 * * *' },
    NOW,
  );

  expect(view.description).toBe(`Every day at ${NINE}`);
});

test('an advanced schedule keeps its expression visible rather than inventing a preset', () => {
  const view = routineScheduleView({ schedule: '5 1,13 * * 1-5' }, NOW);

  expect(view.description).toBe('Advanced schedule (5 1,13 * * 1-5)');
  // The host reported no next run and an advanced expression is not guessed at.
  expect(view.nextRun).toBeNull();
});

test('no schedule at all is unknown, not an empty confident answer', () => {
  expect(routineScheduleView({}, NOW)).toEqual({ description: null, nextRun: null });
});

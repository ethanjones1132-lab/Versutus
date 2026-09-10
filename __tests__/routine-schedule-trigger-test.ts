import {
  cronToTrigger,
  ROUTINE_NOTICE_DATA_KIND,
  routineNoticeData,
  routineNoticeTitle,
  type RoutineNoticeData,
} from '@/lib/notifications/routine-schedule';

// The fire the gateway reported for the unmappable-cadence cases. A literal
// calendar instant makes this suite expire: a fire that is not still ahead of
// the clock is refused, so the day the machine clock passes the fixture its
// case goes red for reasons that have nothing to do with the change under
// test. The far end of the range is therefore pinned past every clock, the
// same way the re-arm suite pins its own.
const NEXT_FIRE = '2999-01-01T09:00:00.000Z';

describe('routine cron → local-notification trigger mapping (pure helpers)', () => {
  test("the default routine schedule maps to a daily trigger at the cron's hour and minute", () => {
    // DEFAULT_ROUTINE_SCHEDULE = '0 9 * * *' — the shape the create form
    // seeds, so it must land on DAILY and not fall back to a one-shot.
    expect(cronToTrigger('0 9 * * *')).toEqual({ type: 'daily', hour: 9, minute: 0 });
  });

  test('a day-of-week cron maps to a weekly trigger on that weekday', () => {
    // cron 1 = Monday; expo numbers 1=Sunday..7=Saturday, so Monday is 2.
    expect(cronToTrigger('15 6 * * 1')).toEqual({ type: 'weekly', weekday: 2, hour: 6, minute: 15 });
  });

  test('cron Sunday (0 and 7) maps to expo weekday 1', () => {
    // expo-notifications numbers weekdays 1=Sunday..7=Saturday; cron numbers
    // them 0=Sunday..6=Saturday and also accepts 7 for Sunday.
    expect(cronToTrigger('0 9 * * 0')).toEqual({ type: 'weekly', weekday: 1, hour: 9, minute: 0 });
    expect(cronToTrigger('0 9 * * 7')).toEqual({ type: 'weekly', weekday: 1, hour: 9, minute: 0 });
  });

  test('a cron with any other field populated never maps to a repeating trigger', () => {
    // day-of-month, month, and set/step/list values all change the cadence in
    // ways DAILY and WEEKLY cannot express — the trigger is a one-shot instead.
    expect(cronToTrigger('0 9 1 * *')).toBeNull();
    expect(cronToTrigger('0 9 * 6 *')).toBeNull();
    expect(cronToTrigger('*/5 * * * *')).toBeNull();
    expect(cronToTrigger('0 9 * * 1-5')).toBeNull();
    expect(cronToTrigger('0 9-17 * * *')).toBeNull();
  });

  test('an unmappable cron falls back to a one-shot at the next fire the gateway reported', () => {
    expect(cronToTrigger('0 9 1 * *', NEXT_FIRE)).toEqual({
      type: 'date',
      date: Date.parse(NEXT_FIRE),
    });
    expect(cronToTrigger('*/5 * * * *', NEXT_FIRE)).toEqual({
      type: 'date',
      date: Date.parse(NEXT_FIRE),
    });
  });

  test('a clock moved past the fixture fire still prices the one-shot it reports', () => {
    // `now` is passed explicitly, three hours on from the instant a wall-clock
    // fixture carries. A fire behind the clock is refused outright — the
    // second assertion is that refusal, and it is exactly how such a fixture
    // takes this suite red once the machine clock catches up with it.
    expect(cronToTrigger('*/5 * * * *', NEXT_FIRE, Date.parse('2026-09-10T12:00:00.000Z'))).toEqual({
      type: 'date',
      date: Date.parse(NEXT_FIRE),
    });
    expect(
      cronToTrigger('*/5 * * * *', '2026-09-10T09:00:00.000Z', Date.parse('2026-09-10T12:00:00.000Z')),
    ).toBeNull();
  });

  test('an unmappable cron with no next fire maps to nothing rather than guessing', () => {
    expect(cronToTrigger('0 9 1 * *')).toBeNull();
    expect(cronToTrigger('*/5 * * * *', 'not-a-date')).toBeNull();
  });

  test('a malformed cron maps to nothing', () => {
    expect(cronToTrigger('')).toBeNull();
    expect(cronToTrigger('bad')).toBeNull();
    expect(cronToTrigger('9 * *')).toBeNull(); // 3 fields
    expect(cronToTrigger('0 9 * * * 2026')).toBeNull(); // 6 fields
    expect(cronToTrigger('61 25 * * *')).toBeNull(); // out-of-range minute and hour
    expect(cronToTrigger('x y * * *')).toBeNull();
  });
});

describe('routine notice content helpers (pure helpers)', () => {
  test('routineNoticeTitle keeps the honest shape: what is due, not what ran', () => {
    expect(routineNoticeTitle('Morning sweep')).toBe('Morning sweep is due');
    expect(routineNoticeTitle('  ')).toBe('Routine is due');
  });

  test('routineNoticeData carries kind, jobId and botId for the tap router', () => {
    const data: RoutineNoticeData = routineNoticeData('job-1', 'scout');
    expect(data).toEqual({ kind: 'routine-due', jobId: 'job-1', botId: 'scout' });
    expect(data.kind).toBe(ROUTINE_NOTICE_DATA_KIND);
  });
});

import { rearmRoutineNotifications, syncRoutineNotification } from '@/lib/notifications/routine-sync';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

// The mock replaces the module, so the trigger-type constants the pure
// mapping module imports must be spelled here — expo numbers them
// SchedulableTriggerInputTypes = { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' }.
jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date' },
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (key: string) => store[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete store[key];
    }),
  };
});

import * as Notifications from 'expo-notifications';
import { keyValueStorage } from '@/lib/storage/key-value';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;
const mockCancel = Notifications.cancelScheduledNotificationAsync as jest.Mock;

// Both ends of the range, so the premise holds on any machine clock: one fire
// the gateway reported that has already passed, and one that has not.
const FIRED = '2001-01-01T09:00:00.000Z';
const DUE = '2999-01-01T09:00:00.000Z';

/** A cadence beyond the two repeating shapes: only the gateway's next fire can price it. */
const sweep = (nextRunAt: string) => ({
  id: 'job-sweep',
  name: '[bot:scout] Minute sweep',
  schedule: '*/5 * * * *',
  nextRunAt,
});

const briefing = {
  id: 'job-briefing',
  name: '[bot:scout] Morning briefing',
  schedule: '0 9 * * *',
};

/** Whatever identifier is currently persisted for one routine job. */
async function storedIdFor(jobId: string): Promise<string | null> {
  return keyValueStorage.getItem(`versutus:routine-notification:${jobId}`);
}

describe('re-arming routine notices as the connection comes up', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSchedule.mockResolvedValue('notif-1');
    mockCancel.mockResolvedValue(undefined);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  });

  test('a one-shot whose gateway fire has passed holds nothing until the gateway names a fresh one', async () => {
    await rearmRoutineNotifications([sweep(FIRED)]);

    // The cron is beyond the two repeating shapes and the only fire the
    // gateway named is behind us: scheduling nothing is the honest landing —
    // a guess would fire a notice at a time the routine will not run.
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  test("the gateway's fresh next fire rebuilds the one-shot", async () => {
    // A read that can only price a fire already behind us schedules nothing —
    // and, holding no mapping, retires nothing either.
    await syncRoutineNotification(sweep(FIRED));
    expect(mockSchedule).not.toHaveBeenCalled();

    await rearmRoutineNotifications([sweep(DUE)]);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0][0].trigger).toEqual({ type: 'date', date: Date.parse(DUE) });
    await expect(storedIdFor('job-sweep')).resolves.toBe('notif-1');
  });

  test('a re-arm whose read names no next fire leaves the held one-shot in place', async () => {
    await rearmRoutineNotifications([sweep(DUE)]);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    mockSchedule.mockClear();
    mockCancel.mockClear();

    // This read is the only one that can price a cadence beyond the two
    // repeating shapes, and it named no fire. Absent data is UNKNOWN: the
    // re-arm must not retire the notice the operator already holds — only a
    // fresh fire, or a pause, may replace or drop it.
    await rearmRoutineNotifications([
      { id: 'job-sweep', name: '[bot:scout] Minute sweep', schedule: '*/5 * * * *' },
    ]);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(storedIdFor('job-sweep')).resolves.toBe('notif-1');
  });

  test('re-arming replaces the held notice — one identifier survives, never a second copy', async () => {
    mockSchedule.mockResolvedValueOnce('notif-old').mockResolvedValueOnce('notif-new');

    await rearmRoutineNotifications([briefing]);
    await rearmRoutineNotifications([briefing]);

    expect(mockCancel).toHaveBeenCalledWith('notif-old');
    expect(mockCancel).not.toHaveBeenCalledWith('notif-new');
    await expect(storedIdFor('job-briefing')).resolves.toBe('notif-new');
  });

  test('a paused routine is not re-armed — its notice stays retired', async () => {
    await rearmRoutineNotifications([{ ...briefing, id: 'job-paused', paused: true }]);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    await expect(storedIdFor('job-paused')).resolves.toBeNull();
  });

  test('a mixed read re-arms only the unpaused routines', async () => {
    await rearmRoutineNotifications([briefing, { ...sweep(DUE), paused: true }]);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    // The re-armed notice still names the Bot its routine belongs to.
    expect(mockSchedule.mock.calls[0][0].content.data).toEqual({
      kind: 'routine-due',
      jobId: 'job-briefing',
      botId: 'scout',
    });
  });

  test('an empty read arms nothing', async () => {
    await rearmRoutineNotifications([]);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe('the provider re-arms as the connection comes up', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');

  test('the re-arm reads the routine list the panes read and handles every unpaused job', () => {
    const src = provider();
    const rearm = src.match(/const rearmRoutineNotices = useCallback\([\s\S]*?\n  \}, \[botJobs\]\);/)?.[0];
    expect(rearm).toBeDefined();
    // Same read and same parse the Routines pane uses, so the re-arm and the
    // pane can never disagree about which jobs exist or when they fire next.
    expect(rearm).toContain('routineJobsFromList(await botJobs.list())');
    expect(rearm).toContain('await rearmRoutineNotifications(jobs)');
    // Best-effort: a failed re-arm never breaks the connection flow.
    expect(rearm).toContain('} catch {');
  });

  test('the effect is gated on the connected status, so a disconnected open arms nothing', () => {
    const src = provider();
    const effect = src.match(
      /useEffect\(\(\) => \{\n    if \(status !== 'connected'\) return;[\s\S]*?\n  \}, \[rearmRoutineNotices, status\]\);/,
    )?.[0];
    expect(effect).toBeDefined();
    // Fire-and-forget: the connection must never wait on a notification read.
    expect(effect).toContain('void rearmRoutineNotices();');
  });
});

describe('the Bot Chat re-arms from the routine read only it can make', () => {
  const screen = () => readSource('src', 'components', 'chat', 'chat-screen.tsx');

  test("the pane's fresh routine read re-arms that Bot's notices", () => {
    const src = screen();
    const effect = src.match(
      /useEffect\(\(\) => \{\n    if \(!botSurfaceId \|\| status !== 'connected'\) return;[\s\S]*?\n  \}, \[botSurfaceId, status, botJobs, foldRoutineRead\]\);/,
    )?.[0];
    expect(effect).toBeDefined();
    // One read, not two: the same parsed list feeds the pane and the re-arm.
    expect(effect).toContain('const read = routineJobsFromList(jobs);');
    expect(effect).toContain('foldRoutineRead(botSurfaceId, { ok: true, jobs: read })');
    expect(effect).toContain('void rearmRoutineNotifications(read);');
    expect((effect?.match(/botJobs\s*\n?\s*\.list\(\)/g) ?? []).length).toBe(1);
  });
});

describe('the sync decides before it retires', () => {
  /** The unpaused half of syncRoutineNotification, up to the next export. */
  const syncBody = () => {
    const src = readSource('src', 'lib', 'notifications', 'routine-sync.ts');
    const start = src.indexOf('export async function syncRoutineNotification');
    const end = src.indexOf('export async function cancelRoutineNotification');
    return start === -1 || end === -1 ? '' : src.slice(start, end);
  };

  test('a read that prices no fire returns before it can cancel the held notice', () => {
    const body = syncBody();
    const decision = body.indexOf('if (!trigger) return;');
    expect(decision).toBeGreaterThan(-1);
    // The retirement on the replacement path sits AFTER the decision: a read
    // that names no fire can no longer retire a notice nothing replaces.
    expect(body.lastIndexOf('await cancelKnownNotice(job.id)')).toBeGreaterThan(decision);
    // A pause IS a decision: it retires the held notice before the trigger is
    // even computed, so an unpriceable paused row still goes.
    const pauseGuard = body.indexOf('if (job.paused)');
    expect(pauseGuard).toBeGreaterThan(-1);
    expect(pauseGuard).toBeLessThan(decision);
  });
});

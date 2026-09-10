// Item 7b of FUTURE-ITEMS.md §7 — the Android half of the live run progress.
//
// Item 7a folded a run row into a notice (run-progress.ts); this is the poster
// that puts that notice in the tray. It is exercised directly against a mocked
// `expo-notifications`, and the provider's write point — a component no test in
// this suite renders — is pinned as source, the way every provider suite here
// pins it.

import { AppState, Platform } from 'react-native';

import { runEventPreview, type ActivityRun } from '@/lib/gateway/runs';
import {
  RUN_PROGRESS_CHANNEL_ID,
  dismissRunProgress,
  notifyRunComplete,
  notifyRunProgress,
} from '@/lib/notifications/local';
import {
  runProgressNotice,
  runProgressNoticeIdentifier,
  type RunProgressNotice,
} from '@/lib/notifications/run-progress';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(),
  dismissNotificationAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  // The channel is created from `AndroidImportance.LOW`, which the platform
  // defines as 4 (NotificationChannelManager.types.d.ts:22-30). The real enum is
  // unreachable behind this mock, so its value is spelled here and asserted
  // below — a mock answering anything else would pin a channel the phone would
  // never build.
  AndroidImportance: { LOW: 4 },
}));

import * as Notifications from 'expo-notifications';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;
const mockDismiss = Notifications.dismissNotificationAsync as jest.Mock;
const mockChannel = Notifications.setNotificationChannelAsync as jest.Mock;

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

/** A source file, for the cases that pin what a module must NOT do. */
function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

// The fold's own clock: the run started 3:42 before the notice is asked for.
const STARTED_AT = Date.parse('2026-09-10T14:00:00Z');
const NOW = STARTED_AT + 222_000;

function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-7',
    prompt: 'Explain the vault layout',
    status: 'running',
    startedAt: STARTED_AT,
    events: [],
    ...overrides,
  };
}

/** The fold's update arm for one run. A retire carries no copy at all. */
function update(
  id: string,
  overrides: Partial<ActivityRun> = {},
): Extract<RunProgressNotice, { verb: 'update' }> {
  const notice = runProgressNotice(run({ id, ...overrides }), NOW);
  if (notice.verb !== 'update') throw new Error(`expected an update, got ${notice.verb}`);
  return notice;
}

/** The fold's retire arm for one run. */
function retire(
  id: string,
  overrides: Partial<ActivityRun> = {},
): Extract<RunProgressNotice, { verb: 'retire' }> {
  const notice = runProgressNotice(run({ id, ...overrides }), NOW);
  if (notice.verb !== 'retire') throw new Error(`expected a retire, got ${notice.verb}`);
  return notice;
}

/** A stored row event, folded the way the driver folds one (provider.tsx:2230). */
function step(text: string): ActivityRun['events'][number] {
  return {
    type: 'message.delta',
    preview: runEventPreview({ type: 'message.delta', data: { deltaText: text } }),
    timestamp: STARTED_AT,
  };
}

// present() refuses to post while the app is foregrounded; the cases below pin
// AppState away from 'active' through a redefinable property so the schedule
// path runs, and flip it back for the suppression case.
const originalStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

function setAppState(value: string): void {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
}

// The notice is Android's, and jest answers `ios` unless a case says otherwise
// — `loadWidgetTarget`'s suite leans on the same default — so the Android cases
// flip it and `restoreAllMocks` puts it back.
function onAndroid(): void {
  jest.replaceProperty(Platform, 'OS', 'android');
}

describe('notifyRunProgress (the Android progress notice)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    mockDismiss.mockResolvedValue(undefined);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    mockSchedule.mockResolvedValue('notif-1');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('the low-importance channel is created once for the process, not once per notice', async () => {
    onAndroid();

    // Three notices, three different runs, posted back to back. The channel is
    // the process's, so the phone is asked for it on the first post only —
    // `setNotificationChannelAsync` renames and re-describes a channel it finds,
    // never re-ranks it, so re-asking per notice buys nothing.
    await notifyRunProgress(update('run-a'));
    await notifyRunProgress(update('run-b'));
    await notifyRunProgress(update('run-c'));

    expect(mockSchedule).toHaveBeenCalledTimes(3);
    expect(mockChannel).toHaveBeenCalledTimes(1);
    expect(mockChannel).toHaveBeenCalledWith(RUN_PROGRESS_CHANNEL_ID, {
      name: 'Run progress',
      importance: 4,
    });
  });

  test('an update re-posts the run’s own identifier, so the tray keeps one notice per run', async () => {
    onAndroid();

    const first = update('run-7');
    await notifyRunProgress(first);
    await notifyRunProgress(update('run-7', { events: [step('reading the config')] }));

    // §7's own mechanism: the identifier is the notification's tag on Android,
    // so the second post replaces the first rather than stacking beside it
    // (ExpoPresentationDelegate.kt:108-112).
    const [firstCall, secondCall] = mockSchedule.mock.calls;
    expect(firstCall[0].identifier).toBe(runProgressNoticeIdentifier('run-7'));
    expect(secondCall[0].identifier).toBe(firstCall[0].identifier);
    expect(secondCall[0].content.body).not.toBe(firstCall[0].content.body);
  });

  test('the notice lands on that channel, and carries the fold’s copy untouched', async () => {
    onAndroid();

    await notifyRunProgress(update('run-7', { status: 'waiting-approval' }));

    const request = mockSchedule.mock.calls[0][0];
    // A channel-carrying trigger is Android's immediate trigger on that channel
    // (ChannelAwareTriggerInput, notifications.md:1908) — the default channel
    // would beep, and this notice must not.
    expect(request.trigger).toEqual({ channelId: RUN_PROGRESS_CHANNEL_ID });
    // The copy is item 7a's, verbatim: re-wording it here would be the poster
    // authoring a step the run never reported.
    expect(request.content.title).toBe('Run needs approval');
    expect(request.content.body).toContain('Elapsed 3:42');
  });

  test('the payload is the fold’s, so a tap still routes to the run', async () => {
    onAndroid();

    await notifyRunProgress(update('run-7'));

    expect(mockSchedule.mock.calls[0][0].content.data).toEqual({ kind: 'run', runId: 'run-7' });
  });

  test('a foregrounded app draws nothing — the shipped rule governs this notice too', async () => {
    // The operator watching the run in the app already has the run card; a
    // tray notice beside it would be the same news twice.
    onAndroid();
    setAppState('active');

    await notifyRunProgress(update('run-7'));

    expect(mockSchedule).not.toHaveBeenCalled();
  });

  test('iOS gets nothing from this slice — the notice is Android’s', async () => {
    await notifyRunProgress(update('run-7'));
    await dismissRunProgress(runProgressNoticeIdentifier('run-7'));

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockChannel).not.toHaveBeenCalled();
  });

  test('web gets nothing either', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');

    await notifyRunProgress(update('run-7'));

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockChannel).not.toHaveBeenCalled();
  });

  test('a notice the phone refuses is not the app’s own failure', async () => {
    onAndroid();
    mockSchedule.mockRejectedValue(new Error('notifications unavailable'));

    await expect(notifyRunProgress(update('run-7'))).resolves.toBeUndefined();
  });

  test('the channel is created from the platform’s own LOW, not a bare number', async () => {
    // The runtime case above reads `importance: 4` through a mock that was told
    // LOW is 4; this is the assertion that the code asked for LOW.
    expect(readSource('src', 'lib', 'notifications', 'local.ts')).toContain(
      'Notifications.AndroidImportance.LOW',
    );
  });
});

describe('dismissRunProgress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    mockDismiss.mockResolvedValue(undefined);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    mockSchedule.mockResolvedValue('notif-1');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('a settled run is dismissed under the identifier its updates were posted with', async () => {
    onAndroid();

    const live = update('run-7');
    const settled = retire('run-7', { status: 'complete' });
    await notifyRunProgress(live);
    await dismissRunProgress(settled.identifier);

    // The same string the update went out under — a dismissal that guessed a
    // different one would leave the notice behind for good.
    expect(settled.identifier).toBe(live.identifier);
    expect(mockSchedule.mock.calls[0][0].identifier).toBe(settled.identifier);
    expect(mockDismiss).toHaveBeenCalledWith(settled.identifier);
  });

  test('a dismissal the phone refuses never propagates — retiring is best-effort', async () => {
    onAndroid();
    mockDismiss.mockRejectedValue(new Error('tray unavailable'));

    await expect(dismissRunProgress(runProgressNoticeIdentifier('run-7'))).resolves.toBeUndefined();
  });
});

describe('the shipped presenters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    mockSchedule.mockResolvedValue('notif-1');
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('a run-complete notice still posts on trigger: null, with no identifier to replace', async () => {
    // Item 7b's must-still: the progress notice is the only notice that carries
    // an identifier and a channel. The ending stays `notifyRunComplete`'s, and it
    // reads exactly as it did before this slice.
    await notifyRunComplete('Run complete', 'wrote 3 files', 'run-7');

    const request = mockSchedule.mock.calls[0][0];
    expect(request.trigger).toBeNull();
    expect('identifier' in request).toBe(false);
    expect(request.content.data).toEqual({ kind: 'run', runId: 'run-7' });
  });
});

describe('the provider writes the notice as run state changes', () => {
  const provider = (): string => readSource('src', 'context', 'gateway-provider.tsx');

  /**
   * The progress notice's write point, as written — body AND dependency list,
   * since the driver is this effect's whole subject. The match runs to the
   * closing `}, [...]);` whatever that list carries.
   */
  const noticeEffect = (): string =>
    provider().match(
      /useEffect\(\(\) => \{\n    const held = runProgressNoticeIdsRef[\s\S]*?\n  \}, \[[^\]]*\]\);/,
    )?.[0] ?? '';

  test('the write point is the run rows, and nothing here ticks on its own', () => {
    const effect = noticeEffect();
    expect(effect).toContain('runProgressNotice(run)');
    // §7: the write points are the run lifecycle hooks, not a new poller. The
    // dependency list IS the driver — a start, an approval wait, a decision, an
    // event, a stop and the disconnect settle each move `activityRuns`.
    expect(effect).not.toMatch(/setInterval|setTimeout/);
  });

  test('one notice per run: an update is re-posted, a settled row is dismissed', () => {
    const effect = noticeEffect();
    expect(effect).toContain("notice.verb === 'update'");
    expect(effect).toContain('notifyRunProgress(notice)');
    expect(effect).toContain('dismissRunProgress(');
    // A run this process holds a notice for and no longer sees in flight is
    // retired too, so nothing is left in the tray for a run nobody follows.
    expect(effect).toContain('for (const identifier of held)');
  });

  test('the poster is the shipped local module’s, and the package stays behind it', () => {
    const src = provider();
    expect(src).toContain('notifyRunProgress,');
    expect(src).toContain('dismissRunProgress,');
    expect(src).toContain("import { runProgressNotice } from '@/lib/notifications/run-progress';");
    expect(src).not.toMatch(/from 'expo-notifications'/);
  });

  test('the ending is still notifyRunComplete’s', () => {
    expect(provider()).toMatch(/notifyRunComplete\(/);
    // The progress effect authors no ending of its own: item 7b hands off.
    expect(noticeEffect()).not.toContain('notifyRunComplete');
  });

  test('the write point re-folds on the app’s own foreground edge, not on a timer', () => {
    const effect = noticeEffect();
    // `present` refuses to draw for a foregrounded app (local.ts:70), so a run
    // that moves while the operator is looking at it contributes nothing to the
    // tray — hence the reading the operator pockets being the last one the
    // backgrounded stretch could have written. The app's own foreground state is
    // in the dependency list so the return to the background re-folds and
    // re-posts what the tray owes, and the foregrounded stretch asks for no
    // notice the gate would only refuse.
    expect(effect).toContain('[activityRuns, appInForeground]');
    expect(effect).toContain('if (!appInForeground)');
    // §7: no poller. A timer here would be a second driver beside the run rows.
    expect(effect).not.toMatch(/setInterval|setTimeout/);
  });

  test('that state is raised by the provider’s own lifecycle listener, and starts true on a live app', () => {
    const src = provider();
    // One subscription for the process, and it is the listener the provider
    // already had — the driver above adds no listener of its own.
    expect(src.match(/AppState\.addEventListener\('change'/g)).toHaveLength(1);
    expect(src).toContain("setAppInForeground(state === 'active')");
    // Seeded from the platform rather than defaulted, so the first render of an
    // app already up is not read as a pocketed one and asked for a notice.
    expect(src).toContain('useState(() => AppState.currentState === \'active\')');
  });
});

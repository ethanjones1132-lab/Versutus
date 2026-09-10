// Item 7b's iOS half (FUTURE-ITEMS.md §7): a run's Live Activity.
//
// Three halves are pinned here. The pure half — the name the component and the
// factory must agree on, the props the banner is handed, and the edge each of
// item 7a's folds asks for — is exercised directly. The seam is exercised
// against a fake activity target, which is what a client with the native side
// would hand it. The two halves that cannot run under jest (the component the
// extension bundles, which imports `expo-widgets`, and the seam's own import of
// it) are pinned as source, the way the widget suite pins its own.

import { Platform } from 'react-native';

import { formatClockTime } from '@/lib/format';
import { runEventPreview, type ActivityRun } from '@/lib/gateway/runs';
import {
  RUN_ACTIVITY_NAME,
  runActivityProps,
  runActivityStep,
  type RunActivityProps,
} from '@/lib/notifications/run-activity';
import {
  loadRunActivityTarget,
  resetRunActivitiesForTests,
  syncRunActivities,
  type RunActivityTarget,
} from '@/lib/notifications/run-activity-device';
import { runProgressNotice } from '@/lib/notifications/run-progress';

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

const COMPONENT_SOURCE_PATH = ['src', 'components', 'widget', 'run-live-activity.tsx'];
const SEAM_SOURCE_PATH = ['src', 'lib', 'notifications', 'run-activity-device.ts'];
const FOLD_SOURCE_PATH = ['src', 'lib', 'notifications', 'run-activity.ts'];

// The same fixed clock the fold's own suite uses: the run started 3:42 before
// the fold is asked, so the elapsed line reads `3:42`.
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

/** A stored row event, folded the way the driver folds one (provider.tsx:2230). */
function previewedStep(text: string): ActivityRun['events'][number] {
  return {
    type: 'message.delta',
    preview: runEventPreview({ type: 'message.delta', data: { deltaText: text } }),
    timestamp: STARTED_AT,
  };
}

/** The fold's update arm, which is the only arm an activity is handed. */
function updateOf(row: ActivityRun): Extract<ReturnType<typeof runProgressNotice>, { verb: 'update' }> {
  const notice = runProgressNotice(row, NOW);
  if (notice.verb !== 'update') throw new Error(`expected an update, got ${notice.verb}`);
  return notice;
}

/** The fold's retire arm: a run that is over. */
function retireOf(row: ActivityRun): Extract<ReturnType<typeof runProgressNotice>, { verb: 'retire' }> {
  const notice = runProgressNotice(row, NOW);
  if (notice.verb !== 'retire') throw new Error(`expected a retire, got ${notice.verb}`);
  return notice;
}

/** One activity as the seam holds it: an id, and the calls it was handed. */
function fakeInstance(id: string) {
  return {
    getId: jest.fn(() => id),
    update: jest.fn(async (_props: RunActivityProps) => {}),
    end: jest.fn(async (_policy?: string, _props?: RunActivityProps) => {}),
  };
}

type FakeInstance = ReturnType<typeof fakeInstance>;

/**
 * The activity target a build with the native side hands the seam.
 *
 * `left` is what a process that is gone left on the Lock Screen: the factory
 * reports those alongside the activities this process starts, which is why the
 * sweep has to tell them apart.
 */
function fakeTarget(left: FakeInstance[] = []) {
  const started: FakeInstance[] = [];
  const start = jest.fn((_props: RunActivityProps) => {
    const instance = fakeInstance(`activity-${started.length + 1}`);
    started.push(instance);
    return instance;
  });
  const getInstances = jest.fn(() => [...left, ...started]);
  return {
    target: { default: { start, getInstances } } as unknown as RunActivityTarget,
    start,
    getInstances,
    started,
  };
}

// One case flips the platform, and `jest.replaceProperty` puts it back only when
// it is asked to — a suite that ran as Android for the rest of its tests would be
// pinning the wrong platform.
afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  resetRunActivitiesForTests();
});

describe('runActivityProps — what the banner is handed, and all it is handed', () => {
  test('every prop is one of item 7a own lines, passed through untouched', () => {
    const step = previewedStep('reading widget-device.ts');
    expect(runActivityProps(updateOf(run({ events: [step] })))).toEqual({
      status: 'Run in progress',
      elapsed: 'Elapsed 3:42',
      step: step.preview,
      updated: `Last update ${formatClockTime(NOW)}`,
    });
    expect(runActivityProps(updateOf(run({ status: 'waiting-approval' }))).status).toBe(
      'Run needs approval',
    );
  });

  test('a run with no event yet hands over no step, and no key for one', () => {
    // The same honesty the fold keeps: an absent reading is absent, never a
    // blank line the banner would draw as an empty one.
    const props = runActivityProps(updateOf(run()));
    expect('step' in props).toBe(false);
    expect(Object.keys(props).sort()).toEqual(['elapsed', 'status', 'updated']);
  });

  test('an unreadable startedAt hands over no elapsed line either', () => {
    const props = runActivityProps(updateOf(run({ startedAt: Number.NaN })));
    expect('elapsed' in props).toBe(false);
    expect(Object.keys(props).sort()).toEqual(['status', 'updated']);
  });

  test('nothing but the copy goes across: no identifier, no payload, no run id', () => {
    // What the Lock Screen is handed is what it draws. A payload here would be a
    // second route into the app — the tap route stays the notification's
    // (tap-route.ts:39-62).
    const props = runActivityProps(updateOf(run()));
    expect(Object.keys(props).sort()).toEqual(['elapsed', 'status', 'updated']);
    expect(JSON.stringify(props)).not.toContain('run-7');
    expect(JSON.stringify(props)).not.toContain('versutus://');
  });
});

describe('runActivityStep — the edge item 7a verb asks the device for', () => {
  test('a run in flight starts an activity the first time and updates it after that', () => {
    // One activity per run, not a stack: the process holding one is what makes
    // the next fold an update. The props ride the edge, so the caller never
    // folds the run a second time.
    const props = runActivityProps(updateOf(run()));
    expect(runActivityStep(updateOf(run()), false)).toEqual({ edge: 'start', props });
    expect(runActivityStep(updateOf(run()), true)).toEqual({ edge: 'update', props });
  });

  test('a settled run ends what this process holds, and is never started', () => {
    // §7's ending is the completion notice's word, so an activity started at the
    // settle would be a second surface announcing the same thing.
    expect(runActivityStep(retireOf(run({ status: 'complete' })), true)).toEqual({ edge: 'end' });
    expect(runActivityStep(retireOf(run({ status: 'complete' })), false)).toEqual({ edge: 'none' });
  });

  test('every ending the fold knows answers the same edge', () => {
    for (const status of ['complete', 'failed', 'cancelled', 'unresolved'] as const) {
      expect(runActivityStep(retireOf(run({ status })), true)).toEqual({ edge: 'end' });
    }
  });
});

describe('loadRunActivityTarget', () => {
  test('hands back the target when this build carries one', async () => {
    const { target } = fakeTarget();
    await expect(loadRunActivityTarget(async () => target)).resolves.toBe(target);
  });

  test('answers null where the module cannot load', async () => {
    // `createLiveActivity` builds the factory on import, and the factory
    // constructor loads the native module — which throws where there is none:
    // Expo Go, and any client built before item 4 landed the dependency.
    const load = jest.fn(async () => {
      throw new Error('Cannot find native module ExpoWidgets');
    });
    await expect(loadRunActivityTarget(load)).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('answers null on a platform with no activity target, without importing anything', async () => {
    const { target } = fakeTarget();
    const load = jest.fn(async () => target);
    jest.replaceProperty(Platform, 'OS', 'android');
    await expect(loadRunActivityTarget(load)).resolves.toBeNull();
    // Asked nothing: item 7's Android half is the notice item 7b posts, and the
    // module that would throw is never reached.
    expect(load).not.toHaveBeenCalled();
  });
});

describe('syncRunActivities', () => {
  test('a run in flight starts one activity, and the next pass updates the same one', async () => {
    const { target, start, started } = fakeTarget();
    await syncRunActivities([updateOf(run())], async () => target);
    await syncRunActivities(
      [updateOf(run({ events: [previewedStep('reading the config')] }))],
      async () => target,
    );

    // One activity, not two: the Lock Screen keeps one per run.
    expect(start).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);
    expect(started[0].update).toHaveBeenCalledTimes(1);
    expect(started[0].update).toHaveBeenCalledWith({
      status: 'Run in progress',
      elapsed: 'Elapsed 3:42',
      step: 'reading the config',
      updated: `Last update ${formatClockTime(NOW)}`,
    });
    // No url and no stale date: the tap route stays the notification's, and a
    // staleness window is not this slice's to invent.
    expect(start.mock.calls[0]).toHaveLength(1);
  });

  test('a settled run is ended with the last props this device wrote, and never started', async () => {
    const { target, start, started } = fakeTarget();
    await syncRunActivities([updateOf(run())], async () => target);
    const written = start.mock.calls[0][0];

    await syncRunActivities([retireOf(run({ status: 'complete' }))], async () => target);

    // The retire carries no copy of its own, so the ending hands back the fold's
    // own final props — the last reading this device wrote.
    expect(started[0].end).toHaveBeenCalledTimes(1);
    expect(started[0].end).toHaveBeenCalledWith(undefined, written);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('a run this process holds and no longer lists is ended too', async () => {
    const { target, started } = fakeTarget();
    await syncRunActivities([updateOf(run())], async () => target);
    await syncRunActivities([], async () => target);

    // Nothing is left on the Lock Screen for a run this process stopped
    // following, whatever took the row away.
    expect(started[0].end).toHaveBeenCalledTimes(1);
  });

  test('a run that is already over when it is listed starts nothing', async () => {
    const { target, start } = fakeTarget();
    await syncRunActivities([retireOf(run({ status: 'failed' }))], async () => target);
    expect(start).not.toHaveBeenCalled();
  });

  test('the first pass of a process ends every activity it did not start, and only once', async () => {
    // ActivityKit outlives the process, so a killed app leaves an activity
    // claiming liveness it no longer has — and nothing in the activity says
    // which run it belonged to (ios/LiveActivityFactory.swift:40-43 matches on
    // the activity's own name), so an unclaimed instance is ended outright.
    const left = [fakeInstance('left-1'), fakeInstance('left-2')];
    const { target, getInstances } = fakeTarget(left);

    await syncRunActivities([], async () => target);

    for (const instance of left) {
      expect(instance.end).toHaveBeenCalledTimes(1);
      expect(instance.end).toHaveBeenCalledWith('immediate');
    }

    // Asked once per process: a later pass must not end anything again, which is
    // the whole reason the Lock Screen is squared once rather than every pass.
    await syncRunActivities([], async () => target);
    expect(getInstances).toHaveBeenCalledTimes(1);
  });

  test('an activity this process started is not swept up as a stranger', async () => {
    // The sweep runs after the rows, so the run still in flight has its activity
    // by then: the process's own is left alone, and the stranger goes.
    const left = [fakeInstance('left-1')];
    const { target, start, started } = fakeTarget(left);

    await syncRunActivities([updateOf(run())], async () => target);

    expect(start).toHaveBeenCalledTimes(1);
    expect(left[0].end).toHaveBeenCalledWith('immediate');
    expect(started[0].end).not.toHaveBeenCalled();
  });

  test('a build that cannot load the activity starts nothing rather than rejecting', async () => {
    const load = jest.fn(async () => {
      throw new Error('Cannot find native module ExpoWidgets');
    });
    await expect(syncRunActivities([updateOf(run())], load)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a platform with no activity target starts nothing, without importing anything', async () => {
    const { target, start } = fakeTarget();
    const load = jest.fn(async () => target);
    jest.replaceProperty(Platform, 'OS', 'android');

    await expect(syncRunActivities([updateOf(run())], load)).resolves.toBeUndefined();

    expect(load).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("an activity that refuses a write is not the app's own failure", async () => {
    const { target, start, started } = fakeTarget();
    await syncRunActivities([updateOf(run())], async () => target);
    started[0].update.mockRejectedValueOnce(new Error('ExpoWidgets is not available'));

    await expect(
      syncRunActivities(
        [updateOf(run({ events: [previewedStep('reading the config')] }))],
        async () => target,
      ),
    ).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('the component and the seam', () => {
  const component = (): string => readSource(...COMPONENT_SOURCE_PATH);
  const seam = (): string => readSource(...SEAM_SOURCE_PATH);
  const fold = (): string => readSource(...FOLD_SOURCE_PATH);

  test('is marked with the directive the extension looks for, and registers the shared name', () => {
    expect(component()).toContain("'widget';");
    expect(component()).toContain('createLiveActivity(RUN_ACTIVITY_NAME,');
    // A literal name here would be a second one to keep in step with the seam.
    expect(component()).not.toMatch(/createLiveActivity\(\s*'/);
  });

  test('draws item 7a props and holds no client, clock or reading of its own', () => {
    const src = component();
    expect(src).toContain('RunActivityProps');
    expect(src).not.toMatch(/useGateway|GatewayContext|gatewayRequest|fetch\(/);
    expect(src).not.toMatch(/Date\.now|new Date\(/);
  });

  test('imports nothing the extension stubs out, and never the seam', () => {
    // expo-widgets bundles the extension with `react`, `react-native` and
    // `react-native-reanimated` stubbed out (expo-widgets/metro.config.js), so an
    // import of any of them would render nothing. The seam owns the react-native
    // import and is app-side only.
    const src = component();
    expect(src).not.toMatch(/^\s*import .*from '(react|react-native|react-native-reanimated)'/m);
    expect(src).not.toMatch(/^\s*import .*run-activity-device/m);
  });

  test('the seam is the caller that may not be static, and it names the component', () => {
    expect(seam()).toContain("import('@/components/widget/run-live-activity')");
    // Static would build the factory at boot, which is the crash the seam exists
    // to avoid.
    expect(seam()).not.toMatch(/^\s*import .*from '@\/components\/widget\/run-live-activity'/m);
    expect(seam()).toContain("if (Platform.OS !== 'ios') return null;");
  });

  test('the fold that decides the edges reaches no device and no package', () => {
    const src = fold();
    expect(src).not.toContain("from 'expo-widgets'");
    expect(src).not.toContain("from 'react-native'");
    expect(src).not.toContain('createLiveActivity');
    expect(src).not.toContain('getInstances');
    // The one import is a type, so the widget bundle carrying this module beside
    // the component does not pull `expo-notifications` in with it.
    expect(src).toContain("import type { RunProgressNotice } from './run-progress';");
    expect(src).not.toMatch(/^import (?!type)/m);
  });

  test('the name is one string, spelled once, and the component is its reader', () => {
    expect(RUN_ACTIVITY_NAME).toBe('VersutusRunActivity');
    expect(component()).toContain('RUN_ACTIVITY_NAME');
    // The native side keys the layout by this string, and the factory is built
    // with it — so a second spelling anywhere would be a second name to keep in
    // step, and the bundle would look for a layout nobody wrote.
    expect(fold()).toContain(`= '${RUN_ACTIVITY_NAME}';`);
    expect(component()).not.toContain(`'${RUN_ACTIVITY_NAME}'`);
    expect(seam()).not.toContain(RUN_ACTIVITY_NAME);
  });
});

// The write point is one effect in the provider, and the provider is not a
// component any test here renders — so it is pinned as source, the way every
// other provider suite in `__tests__/` pins it.
describe('the provider hands the same folds to both surfaces', () => {
  const provider = (): string => readSource('src', 'context', 'gateway-provider.tsx');
  const writeEffect = (): string =>
    provider().match(
      /useEffect\(\(\) => \{\n    const held = runProgressNoticeIdsRef[\s\S]*?\n  \}, \[[^\]]*\]\);/,
    )?.[0] ?? '';

  test('the activity is asked for in the same pass, from the same folds', () => {
    const effect = writeEffect();
    expect(effect).toContain('const notices = activityRuns.map((run) => runProgressNotice(run));');
    expect(effect).toContain('void syncRunActivities(notices);');
  });

  test('the driver is still those facts, and nothing ticks on its own', () => {
    const effect = writeEffect();
    expect(effect).toContain('}, [activityRuns, appInForeground]);');
    expect(effect).not.toMatch(/setInterval|setTimeout/);
  });

  test('the iOS ask is not gated on the foreground, and the Android one still is', () => {
    // A Live Activity is drawn on a pocketed phone whatever this process is
    // doing; the notice is not, because nothing is drawn while the app is up
    // (local.ts:70). So the two surfaces part company here and nowhere else.
    const effect = writeEffect();
    expect(effect).toContain('if (!appInForeground) void notifyRunProgress(notice);');
    expect(effect).not.toMatch(/appInForeground[^)]*syncRunActivities/);
  });

  test('the seam is the only place the Lock Screen is touched', () => {
    const src = provider();
    expect(src).toContain(
      "import { syncRunActivities } from '@/lib/notifications/run-activity-device';",
    );
    // Not the component module and not the package: `run-activity-device.ts` is
    // the one file allowed to name either, and it names them lazily.
    expect(src).not.toMatch(/from '@\/components\/widget\/run-live-activity'/);
    expect(src).not.toMatch(/from 'expo-widgets'/);
    expect(src).not.toMatch(/createLiveActivity/);
  });
});

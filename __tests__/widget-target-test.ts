// Item 4b of FUTURE-ITEMS.md §4: the widget target.
//
// Two halves are pinned here. The pure half — the name the plugin entry and the
// factory must agree on, and the lines the body draws — is exercised directly.
// The two halves that cannot run under jest (the component the extension
// bundles, which imports `expo-widgets`, and the seam's own import of it) are
// pinned as source, the way the share-intent suite pins its app.json entry.

import { Platform } from 'react-native';

import { formatClockTime } from '@/lib/format';
import type { ConnectionStatus } from '@/lib/gateway/types';
import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';
import {
  loadWidgetTarget,
  writeWidgetSnapshot,
  type WidgetTarget,
} from '@/lib/widget/widget-device';
import { glanceableWidgetLines, WIDGET_NAME } from '@/lib/widget/widget-target';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

// The seam keeps the payload it last wrote in AsyncStorage, for the push merge.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const COMPONENT_SOURCE_PATH = ['src', 'components', 'widget', 'glanceable-widget.tsx'];
const SEAM_SOURCE_PATH = ['src', 'lib', 'widget', 'widget-device.ts'];

type WidgetEntryProps = {
  bundleIdentifier?: string;
  groupIdentifier?: string;
  enablePushNotifications?: unknown;
  enableAndroid?: boolean;
  widgets: {
    name: string;
    displayName?: string;
    description?: string;
    supportedFamilies?: string[];
    android?: {
      minWidth: number;
      minHeight: number;
      targetCellWidth: number;
      targetCellHeight: number;
      resizeMode: string;
    };
  }[];
};

const NOW = 1757400000000;

function snapshot(overrides: Partial<GlanceableSnapshot> = {}): GlanceableSnapshot {
  return {
    status: 'connected',
    runsInFlight: 0,
    approvalsPending: 0,
    writtenAt: NOW,
    ...overrides,
  };
}

// One case below flips the platform, and `jest.replaceProperty` puts it back
// only when it is asked to — a suite that ran as Android for the rest of its
// tests would be pinning the wrong platform.
afterEach(() => {
  jest.restoreAllMocks();
});

describe('the widget entry in app.json', () => {
  const plugins = (): unknown[] =>
    (JSON.parse(readSource('app.json')) as { expo: { plugins: unknown[] } }).expo.plugins;

  const widgetEntries = (): [string, WidgetEntryProps][] =>
    plugins().filter(
      (entry): entry is [string, WidgetEntryProps] =>
        Array.isArray(entry) && entry[0] === 'expo-widgets',
    );

  test('one entry, naming one widget, and the name is the one the factory is handed', () => {
    const entries = widgetEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][1].widgets.map((widget) => widget.name)).toEqual([WIDGET_NAME]);
  });

  test('the entry carries its own identifiers, because the plugin no-ops without one', () => {
    // app.json names no `ios.bundleIdentifier`, and `withIosWidgets` hands the
    // config back untouched unless the plugin props carry one (`bundleIdentifier`
    // or `groupIdentifier` — expo-widgets/plugin/build/ios/withIosWidgets.js:16-23).
    // A bare "expo-widgets" string entry would therefore build no widget at all.
    const [, props] = widgetEntries()[0];
    expect(props.bundleIdentifier).toBe('com.versutus.app.widgets');
    expect(props.groupIdentifier).toBe('group.com.versutus.app');
    // Live Activities are item 6's business, not this entry's.
    expect(props.enablePushNotifications).toBeUndefined();
  });

  test('the gallery copy and the families are the ones the body has room for', () => {
    const [widget] = widgetEntries()[0][1].widgets;
    expect(widget.displayName).toBe('Status');
    expect(typeof widget.description).toBe('string');
    expect(widget.description).not.toBe('');
    expect(widget.supportedFamilies).toEqual(['systemSmall', 'systemMedium']);
  });

  test('expo-widgets serves iOS only; Android is drawn by modules/versutus-widget', () => {
    const [, props] = widgetEntries()[0];
    expect(props.enableAndroid).toBe(false);
    expect(props.widgets[0].android).toBeUndefined();
    const pkg = JSON.parse(readSource('package.json'));
    expect(pkg.expo.autolinking.android.exclude).toContain('expo-widgets');
  });

  test('the share entry is still the last thing in the list', () => {
    // The entry was inserted ahead of it rather than appended, so the pins the
    // share-intent suite already holds stay true without being edited
    // (`__tests__/share-intent-test.ts` pins `plugins[0]`, the first eight, and
    // the share entry last).
    const list = plugins();
    const indexOf = (name: string): number =>
      list.findIndex((entry) => Array.isArray(entry) && entry[0] === name);
    const shareIndex = indexOf('expo-share-intent');
    expect(list[0]).toBe('expo-router');
    expect(indexOf('expo-widgets')).toBeGreaterThan(-1);
    expect(indexOf('expo-widgets')).toBeLessThan(shareIndex);
    expect(shareIndex).toBe(list.length - 1);
  });
});

describe('the widget component', () => {
  const source = (): string => readSource(...COMPONENT_SOURCE_PATH);

  test('is marked with the directive the extension looks for, and registers the shared name', () => {
    expect(source()).toContain("'widget';");
    expect(source()).toContain('createWidget(WIDGET_NAME,');
    // A literal name here would be a second one to keep in step with the plugin.
    expect(source()).not.toMatch(/createWidget\(\s*'/);
  });

  test('takes item 4a snapshot as its props and holds no gateway client', () => {
    const src = source();
    expect(src).toContain('GlanceableSnapshot');
    expect(src).not.toMatch(/useGateway|GatewayContext|gatewayRequest|fetch\(/);
  });

  test('imports nothing the widget bundle stubs out, and never the seam', () => {
    // expo-widgets bundles the extension with `react`, `react-native` and
    // `react-native-reanimated` stubbed out (expo-widgets/metro.config.js), so an
    // import of any of them would render nothing. The seam owns the react-native
    // import and is app-side only.
    const src = source();
    expect(src).not.toMatch(/^\s*import .*from '(react|react-native|react-native-reanimated)'/m);
    // The seam is named in the header comment; only an import would reach it.
    expect(src).not.toMatch(/^\s*import .*widget-device/m);
  });

  test('the seam is the caller that may not be static, and it names the component', () => {
    expect(readSource(...SEAM_SOURCE_PATH)).toContain(
      "import('@/components/widget/glanceable-widget')",
    );
  });

  test('opens the app through the same chat link the Android card uses', () => {
    expect(source()).toContain("widgetURL('versutus://chat')");
  });
});

// Nothing on Android evaluates the expo-widgets component any more: the platform
// draws from `modules/versutus-widget`, so the sibling file is deleted rather
// than kept alive as a stub.
describe('the Android widget component', () => {
  test('no expo-widgets component exists for Android, because nothing there could render it', () => {
    const fs = jest.requireActual('fs') as { existsSync(path: string): boolean };
    expect(fs.existsSync([__dirname, '..', 'src', 'components', 'widget', 'glanceable-widget.android.tsx'].join(SEP))).toBe(false);
  });
});

describe('loadWidgetTarget', () => {
  const target = { default: { name: WIDGET_NAME } } as unknown as WidgetTarget;

  test('hands back the widget when this build carries one', async () => {
    await expect(loadWidgetTarget(async () => target)).resolves.toBe(target);
  });

  test('answers null where the module cannot load', async () => {
    const load = jest.fn(async () => {
      throw new Error('Cannot find native module ExpoWidgets');
    });
    await expect(loadWidgetTarget(load)).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('answers null on a platform with no widget target, without importing anything', async () => {
    const load = jest.fn(async () => target);
    jest.replaceProperty(Platform, 'OS', 'web');
    await expect(loadWidgetTarget(load)).resolves.toBeNull();
    // Asked nothing: the module that would throw is never reached.
    expect(load).not.toHaveBeenCalled();
  });

  test('answers null on Android without importing the iOS target', async () => {
    const load = jest.fn(async () => target);
    jest.replaceProperty(Platform, 'OS', 'android');
    await expect(loadWidgetTarget(load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('writeWidgetSnapshot', () => {
  const target = (updateSnapshot: jest.Mock): WidgetTarget =>
    ({ default: { updateSnapshot } }) as unknown as WidgetTarget;

  test('hands the snapshot to the widget the seam loaded, once', async () => {
    const updateSnapshot = jest.fn();
    const snap = snapshot({ runsInFlight: 2, approvalsPending: 1 });

    await expect(writeWidgetSnapshot(snap, async () => target(updateSnapshot))).resolves.toBe(true);

    expect(updateSnapshot).toHaveBeenCalledTimes(1);
    expect(updateSnapshot).toHaveBeenCalledWith(snap);
  });

  test('a build that cannot load the widget writes nothing rather than rejecting', async () => {
    // The same load `loadWidgetTarget` answers null for: a client built before
    // this dependency landed must not fail a run's settle over a widget.
    const load = jest.fn(async () => {
      throw new Error('Cannot find native module ExpoWidgets');
    });

    await expect(writeWidgetSnapshot(snapshot(), load)).resolves.toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a platform with no widget target writes nothing, without importing anything', async () => {
    const updateSnapshot = jest.fn();
    const load = jest.fn(async () => target(updateSnapshot));
    jest.replaceProperty(Platform, 'OS', 'web');

    await expect(writeWidgetSnapshot(snapshot(), load)).resolves.toBe(false);

    expect(load).not.toHaveBeenCalled();
    expect(updateSnapshot).not.toHaveBeenCalled();
  });

  test('on Android the snapshot goes to the Glance module as its payload, never to expo-widgets', async () => {
    const updateSnapshot = jest.fn();
    const load = jest.fn(async () => target(updateSnapshot));
    const setPayload = jest.fn(async () => true);
    const loadAndroid = jest.fn(async () => ({ setPayload, clearPayload: jest.fn() }) as never);
    jest.replaceProperty(Platform, 'OS', 'android');
    const snap = snapshot({ runsInFlight: 1 });

    await expect(writeWidgetSnapshot(snap, load, loadAndroid)).resolves.toBe(true);

    expect(setPayload).toHaveBeenCalledWith(JSON.stringify(androidWidgetPayload(snap)));
    expect(load).not.toHaveBeenCalled();
    expect(updateSnapshot).not.toHaveBeenCalled();
  });

  test("a widget that refuses the write is not the app's own failure", async () => {
    const updateSnapshot = jest.fn(() => {
      throw new Error('ExpoWidgets is not available');
    });

    await expect(writeWidgetSnapshot(snapshot(), async () => target(updateSnapshot))).resolves
      .toBe(false);
    expect(updateSnapshot).toHaveBeenCalledTimes(1);
  });
});

// The write point (item 4c) is one effect in the provider, and the provider is
// not a component any test here renders — so it is pinned as source, the way
// every other provider suite in `__tests__/` pins it.
describe('the provider writes the snapshot as run state changes', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
  const writeEffect = (): string =>
    provider().match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/g)
      ?.find((effect) => effect.includes('void writeWidgetSnapshot(')) ?? '';

  test('the write gate retains its accepted state across effect fires', () => {
    expect(provider()).toContain("from '@/lib/widget/widget-write-gate'");
    expect(provider()).toContain('const widgetWriteRef = useRef<WidgetWriteGateState | null>(null);');
    const effect = writeEffect();
    expect(effect).toContain('const snapshot = glanceableSnapshot(');
    expect(effect).toContain('const decision = widgetWriteGate(widgetWriteRef.current, snapshot, snapshot.writtenAt);');
    expect(effect).toContain('if (!decision.write && !forced) {');
    expect(effect).toContain('widgetWriteRef.current = decision.last;');
    expect(effect).toContain('void writeWidgetSnapshot(snapshot).then((accepted) => {');
  });

  test('the accepted state is committed only once the card took the write', () => {
    // The order that cost a session its card: charging the gate for a payload the
    // native module refused froze the card for five minutes, and for the whole
    // session when no fact moved again to trigger the next write.
    const effect = writeEffect();
    expect(effect.indexOf('void writeWidgetSnapshot(snapshot).then((accepted) => {')).toBeLessThan(
      effect.indexOf('widgetWriteRef.current = decision.last;'),
    );
    expect(effect).toContain('if (!accepted) {');
    // Two overlapping writes must never both commit: an older answer arriving
    // late may not move the gate back to a state the card has already left.
    expect(effect).toContain('if (run !== widgetWriteRunRef.current) return;');
  });

  test('the snapshot is item 4a fold, composed from the facts the provider holds', () => {
    expect(provider()).toContain("import { glanceableSnapshot } from '@/lib/widget/snapshot';");
    expect(writeEffect()).toContain('runs: activityRunsForActiveGateway');
    expect(writeEffect()).toContain('routines: fleetRoutineRead(routineRead, activeGateway?.id).jobs');
    expect(writeEffect()).toContain('bots: widgetBots');
    expect(writeEffect()).toContain('redact: widgetRedact');
  });

  test('the write is driven by those facts and by the clock the floor needs', () => {
    const effect = writeEffect();
    // The dependency list IS the driver: every fact the snapshot carries, the
    // tick that moves `now` without a fact moving, and the timer helpers.
    for (const dep of [
      'activityRunsForActiveGateway',
      'routineRead',
      'activeGateway?.id',
      'status',
      'widgetBots',
      'widgetRedact',
      'widgetTick',
      'isBootstrapped',
      'armWidgetFloor',
      'armWidgetRetry',
      'dropWidgetRetry',
    ]) {
      expect(effect.slice(effect.lastIndexOf('}, ['))).toContain(dep);
    }
    // No poll of the facts: the floor is re-armed off the last accepted write
    // and fires once, without reading anything back.
    expect(effect).not.toMatch(/setInterval/);
    expect(provider()).toContain('armWidgetFloor(decision.last.writtenAt);');
    expect(provider()).toContain('const remaining = WIDGET_WRITE_FLOOR_MS - (Date.now() - from);');
    expect(provider()).toContain('armWidgetRetry();');
    // Dropped on unmount and before each re-arm, so no timer accumulates.
    expect(provider()).toContain(
      'if (widgetFloorTimerRef.current) clearTimeout(widgetFloorTimerRef.current);',
    );
  });

  test('a refused write is re-offered on its own ladder, not only on the next change', () => {
    const src = provider();
    expect(src).toContain('WIDGET_WRITE_RETRY_MS');
    expect(src).toContain('WIDGET_WRITE_RETRY_MAX_MS');
    expect(src).toContain('widgetRetryDelayRef.current = Math.min(delay * 2, WIDGET_WRITE_RETRY_MAX_MS);');
    // The facts may never move again, so the retry re-asks past the gate's own
    // refusal; the first accepted write resets the ladder.
    expect(src).toContain('widgetForcedRef.current = true;');
    expect(src).toContain('widgetRetryDelayRef.current = WIDGET_WRITE_RETRY_MS;');
  });

  test('the foreground return re-decides the floor, on the one lifecycle listener', () => {
    const src = provider();
    // The card's stamp must not age into the native stale threshold while the app
    // is open, and JS timers freeze while it is backgrounded — so the return to
    // active is the second edge that moves `now`.
    expect(src).toContain('if (state === \'active\') setWidgetTick((tick) => tick + 1);');
    expect(src.match(/AppState\.addEventListener\('change'/g)).toHaveLength(1);
  });

  test('no active gateway clears the card once and resets the gate', () => {
    const effect = writeEffect();
    expect(provider()).toContain('void clearWidgetSnapshot();');
    expect(effect).toContain('if (!gatewayId) {');
    expect(effect).toContain('widgetWriteRef.current = null;');
    // Once per absence: the effect re-fires on every unrelated fact change. And
    // not before the profiles are read: a cold start must not wipe the card the
    // operator left from the last session.
    expect(effect).toContain('if (!isBootstrapped || widgetClearedRef.current) return undefined;');
    expect(effect.indexOf('void clearWidgetSnapshot();')).toBeLessThan(
      effect.indexOf('widgetClearedRef.current = false;'),
    );
  });

  test('the roster is keyed by gateway, so a switch never writes the old Bot names', () => {
    const src = provider();
    expect(src).toContain('if (live && gatewayId === activeGateway?.id) setWidgetBotRead({ gatewayId, bots });');
    expect(src.replace(/\s+/g, ' ')).toContain(
      'activeGateway?.id && widgetBotRead.gatewayId === activeGateway?.id ? widgetBotRead.bots : []',
    );
  });

  test('the seam is the only place the widget is touched', () => {
    const src = provider();
    // Not the component module and not the package: `widget-device.ts` is the
    // one file allowed to name either, and it names them lazily.
    expect(src).toContain("import { clearWidgetSnapshot, writeWidgetSnapshot } from '@/lib/widget/widget-device';");
    expect(src).not.toMatch(/from '@\/components\/widget\//);
    expect(src).not.toMatch(/from 'expo-widgets'/);
    expect(src).not.toMatch(/updateSnapshot/);
  });

  test('the routine half is read through the same cron seam the Activity tab uses', () => {
    const src = provider();
    const start = src.indexOf('const [routineRead, setRoutineRead]');
    const end = src.indexOf('}, [activeGateway?.id, cron, status, scheduleConnectedRead]);', start);
    const read = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(read).toContain('await cron.list()');
    expect(read).toContain('setRoutineRead(beginFleetRoutineRead)');
    expect(read).toContain("if (status !== 'connected' || !cron.available || !gatewayId) return;");
    // A failed read retains the list; only a landed list may replace it.
    expect(read).toContain("routineReadRef.current = { gatewayId, jobs, status: 'ready' };");
    expect(read).toContain("setRoutineRead({ gatewayId, jobs, status: 'ready' });");
    expect(read).toContain('live = false;');
    // SPD-4: the read takes its turn behind the transcript instead of competing
    // with it, and its timer is dropped if the connection leaves first.
    expect(read).toContain('scheduleConnectedRead(CONNECTED_ROUTINE_LIST_DELAY_MS, () => {');
    expect(read).toContain('cancelRead?.();');
  });

  test('the Bot rows come from the roster read once per connect, like the routines', () => {
    const read = provider().match(
      /useEffect\(\(\) => \{\n    if \(status !== 'connected'\) return undefined;[\s\S]*?\n  \}, \[activeGateway\?\.id, listBots, status, scheduleConnectedRead\]\);/,
    )?.[0];
    expect(read).toBeDefined();
    expect(read).toContain('const gatewayId = activeGateway?.id;');
    expect(read).toContain('.then((bots) =>');
    // Keyed by the gateway that read it, so a switch cannot leave the previous
    // gateway's Bot names on the card while the new roster is still in flight.
    expect(read).toContain('if (live && gatewayId === activeGateway?.id) setWidgetBotRead({ gatewayId, bots });');
    expect(read).toContain('.catch(() => undefined);');
    expect(read).toContain('scheduleConnectedRead(CONNECTED_WIDGET_BOTS_DELAY_MS, () => {');
  });

  test('the run lifecycle it rides on still persists, and the Runs destination reads active gateway runs', () => {
    const patch = provider().match(
      /const patchActivityRuns = useCallback\([\s\S]*?\n  \}, \[\]\);/,
    )?.[0];
    expect(patch).toContain('void saveActivityRuns(next);');
    // The Runs destination now reads activityRunsForActiveGateway (scoped to active gateway).
    expect(readSource('src', 'app', 'runs.tsx')).toContain('runs={activityRunsForActiveGateway}');
  });
});

describe('glanceableWidgetLines', () => {
  const STATUSES: ConnectionStatus[] = [
    'connected',
    'connecting',
    'reconnecting',
    'pairing',
    'disconnected',
  ];

  test('the connection is the app own word for it, and matches the badge table', () => {
    // The badge's table is the one the operator already reads; this fold keeps a
    // second copy because that module imports reanimated. Pinning the two to
    // each other is what stops the copy drifting.
    const badge = readSource('src', 'components', 'connection-badge.tsx');
    for (const status of STATUSES) {
      const shipped = new RegExp(`${status}: '([^']+)'`).exec(badge);
      expect(shipped).not.toBeNull();
      expect(glanceableWidgetLines(snapshot({ status })).status).toBe(shipped?.[1]);
    }
  });

  test('approvals are reported first, and an approval is not also counted as in flight', () => {
    expect(glanceableWidgetLines(snapshot({ runsInFlight: 2, approvalsPending: 2 })).work).toBe(
      '2 runs waiting on your approval',
    );
    expect(glanceableWidgetLines(snapshot({ runsInFlight: 3, approvalsPending: 1 })).work).toBe(
      '1 run waiting on your approval · 2 runs in flight',
    );
    expect(glanceableWidgetLines(snapshot({ runsInFlight: 1 })).work).toBe('1 run in flight');
  });

  test('a snapshot with no work says so rather than saying nothing', () => {
    expect(glanceableWidgetLines(snapshot()).work).toBe('No runs in flight');
  });

  test('the newest outcome is passed through in its own words, and absent when none was judged', () => {
    expect(glanceableWidgetLines(snapshot({ lastResult: 'wrote 3 files' })).result).toBe(
      'wrote 3 files',
    );
    expect('result' in glanceableWidgetLines(snapshot())).toBe(false);
  });

  test('the stamp names the day it was written, not today', () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    expect(glanceableWidgetLines(snapshot({ writtenAt: yesterday }), NOW).written).toBe(
      `Written Yesterday ${formatClockTime(yesterday)}`,
    );
    expect(glanceableWidgetLines(snapshot({ writtenAt: NOW }), NOW).written).toBe(
      `Written Today ${formatClockTime(NOW)}`,
    );
  });

  test('the routine tallies become a single line, worded from the snapshot only', () => {
    expect(
      glanceableWidgetLines(snapshot({ routineAlerts: { late: 1, failing: 2 } })).routines,
    ).toBe('2 failing · 1 late');
    expect(glanceableWidgetLines(snapshot({ routineAlerts: { late: 0, failing: 1 } })).routines).toBe(
      '1 failing',
    );
    expect(glanceableWidgetLines(snapshot({ routineAlerts: { late: 3, failing: 0 } })).routines).toBe(
      '3 late',
    );
    // A zero-both tally is nothing to read: absent, not "0 · 0".
    expect('routines' in glanceableWidgetLines(snapshot({ routineAlerts: { late: 0, failing: 0 } })))
      .toBe(false);
    expect('routines' in glanceableWidgetLines(snapshot())).toBe(false);
  });

  test('an unreadable stamp says so instead of printing a blank one', () => {
    expect(glanceableWidgetLines(snapshot({ writtenAt: Number.NaN }), NOW).written).toBe(
      'Written at an unreadable time',
    );
  });
});

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
  widgets: {
    name: string;
    displayName?: string;
    description?: string;
    supportedFamilies?: string[];
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
    jest.replaceProperty(Platform, 'OS', 'android');
    await expect(loadWidgetTarget(load)).resolves.toBeNull();
    // Asked nothing: the module that would throw is never reached.
    expect(load).not.toHaveBeenCalled();
  });
});

describe('writeWidgetSnapshot', () => {
  const target = (updateSnapshot: jest.Mock): WidgetTarget =>
    ({ default: { updateSnapshot } }) as unknown as WidgetTarget;

  test('hands the snapshot to the widget the seam loaded, once', async () => {
    const updateSnapshot = jest.fn();
    const snap = snapshot({ runsInFlight: 2, approvalsPending: 1 });

    await writeWidgetSnapshot(snap, async () => target(updateSnapshot));

    expect(updateSnapshot).toHaveBeenCalledTimes(1);
    expect(updateSnapshot).toHaveBeenCalledWith(snap);
  });

  test('a build that cannot load the widget writes nothing rather than rejecting', async () => {
    // The same load `loadWidgetTarget` answers null for: a client built before
    // this dependency landed must not fail a run's settle over a widget.
    const load = jest.fn(async () => {
      throw new Error('Cannot find native module ExpoWidgets');
    });

    await expect(writeWidgetSnapshot(snapshot(), load)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a platform with no widget target writes nothing, without importing anything', async () => {
    const updateSnapshot = jest.fn();
    const load = jest.fn(async () => target(updateSnapshot));
    jest.replaceProperty(Platform, 'OS', 'android');

    await expect(writeWidgetSnapshot(snapshot(), load)).resolves.toBeUndefined();

    expect(load).not.toHaveBeenCalled();
    expect(updateSnapshot).not.toHaveBeenCalled();
  });

  test("a widget that refuses the write is not the app's own failure", async () => {
    const updateSnapshot = jest.fn(() => {
      throw new Error('ExpoWidgets is not available');
    });

    await expect(writeWidgetSnapshot(snapshot(), async () => target(updateSnapshot))).resolves
      .toBeUndefined();
    expect(updateSnapshot).toHaveBeenCalledTimes(1);
  });
});

// The write point (item 4c) is one effect in the provider, and the provider is
// not a component any test here renders — so it is pinned as source, the way
// every other provider suite in `__tests__/` pins it.
describe('the provider writes the snapshot as run state changes', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
  const writeEffect = (): string =>
    provider().match(
      /useEffect\(\(\) => \{\n    void writeWidgetSnapshot\([\s\S]*?\n  \}, \[[^\]]*\]\);/,
    )?.[0] ?? '';

  test('the snapshot is item 4a fold, composed from the facts the provider holds', () => {
    expect(provider()).toContain("import { glanceableSnapshot } from '@/lib/widget/snapshot';");
    expect(writeEffect()).toContain(
      'glanceableSnapshot({ status, runs: activityRuns, routines: routineJobs })',
    );
  });

  test('the write is driven by those facts, not by a poller of its own', () => {
    const effect = writeEffect();
    // The dependency list IS the driver: every fact the snapshot carries, and
    // nothing in the effect that ticks on its own.
    expect(effect).toContain('}, [activityRuns, routineJobs, status]);');
    expect(effect).not.toMatch(/setInterval|setTimeout/);
  });

  test('the seam is the only place the widget is touched', () => {
    const src = provider();
    // Not the component module and not the package: `widget-device.ts` is the
    // one file allowed to name either, and it names them lazily.
    expect(src).toContain("import { writeWidgetSnapshot } from '@/lib/widget/widget-device';");
    expect(src).not.toMatch(/from '@\/components\/widget\//);
    expect(src).not.toMatch(/from 'expo-widgets'/);
    expect(src).not.toMatch(/updateSnapshot/);
  });

  test('the routine half is read through the same cron seam the Activity tab uses', () => {
    const src = provider();
    const read = src.match(
      /useEffect\(\(\) => \{\n    if \(status !== 'connected' \|\| !cron\.available\) return;[\s\S]*?\n  \}, \[cron, status\]\);/,
    )?.[0];
    expect(read).toBeDefined();
    expect(read).toContain('.list()');
    // A failed read is not an empty one: only a landed list may replace it.
    expect(read).toContain('if (live) setRoutineJobs(jobs);');
  });

  test('the run lifecycle it rides on still persists, and the tab still reads it', () => {
    const patch = provider().match(
      /const patchActivityRuns = useCallback\([\s\S]*?\n  \}, \[\]\);/,
    )?.[0];
    expect(patch).toContain('void saveActivityRuns(next);');
    // The tab's own read of the same state, unchanged.
    expect(readSource('src', 'app', '(tabs)', 'activity.tsx')).toContain('runs={activityRuns}');
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

  test('an unreadable stamp says so instead of printing a blank one', () => {
    expect(glanceableWidgetLines(snapshot({ writtenAt: Number.NaN }), NOW).written).toBe(
      'Written at an unreadable time',
    );
  });
});

// The clear path is the one write a widget cannot make by writing nothing: on
// iOS there is no `clearPayload` (expo-widgets' Widget offers reload,
// updateSnapshot and updateTimeline only — Widgets.js), so a removed gateway's
// Bot names and last result would stay on the home screen with no later write to
// retire them. The seam hands the target an empty snapshot through the same
// `updateSnapshot` every other iOS write uses.
//
// The Android path has its own native clear and its own tests
// (`widget-device-write-test.ts`); these cases pin the iOS half and that a clear
// never reaches across platforms.

import { Platform } from 'react-native';

import { keyValueStorage } from '@/lib/storage/key-value';
import {
  clearWidgetSnapshot,
  readLastWidgetPayload,
  WIDGET_LAST_PAYLOAD_KEY,
  writeWidgetSnapshot,
  type AndroidWidgetModule,
  type WidgetTarget,
} from '@/lib/widget/widget-device';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const NOW = 1_757_400_000_000;

function fakeTarget(updateSnapshot: jest.Mock): WidgetTarget {
  return { default: { updateSnapshot } } as unknown as WidgetTarget;
}

/** The Android module this platform does not carry. */
const absentAndroid = async (): Promise<AndroidWidgetModule> => {
  throw new Error('Cannot find native module VersutusWidget');
};

function snapshot(overrides: Partial<GlanceableSnapshot> = {}): GlanceableSnapshot {
  return { status: 'connected', runsInFlight: 0, approvalsPending: 0, writtenAt: NOW, ...overrides };
}

beforeEach(async () => {
  await keyValueStorage.removeItem(WIDGET_LAST_PAYLOAD_KEY);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('clearing on iOS', () => {
  test('hands the widget an empty snapshot instead of the facts it was holding', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const updateSnapshot = jest.fn();
    const load = async () => fakeTarget(updateSnapshot);
    const live = snapshot({
      runsInFlight: 1,
      lastResult: 'Deployed the fix',
      bots: [{ id: 'scout', label: 'Scout' }],
    });

    await expect(writeWidgetSnapshot(live, load, absentAndroid)).resolves.toBe(true);
    await clearWidgetSnapshot(absentAndroid, load);

    // The first snapshot carried the Bots and the result; the clear must hand the
    // target a second one that carries neither, or the home screen keeps the
    // gateway that has just been removed.
    expect(updateSnapshot).toHaveBeenCalledTimes(2);
    const cleared = updateSnapshot.mock.calls[1][0] as GlanceableSnapshot;

    expect(cleared.status).toBe('disconnected');
    expect(cleared.runsInFlight).toBe(0);
    expect(cleared.approvalsPending).toBe(0);
    expect(cleared).not.toHaveProperty('lastResult');
    expect(cleared).not.toHaveProperty('runs');
    expect(cleared).not.toHaveProperty('bots');
    expect(cleared).not.toHaveProperty('configBots');
    // A cleared card still says when it was last written, as every snapshot does.
    expect(Number.isFinite(cleared.writtenAt)).toBe(true);
  });

  test('the clear lands after a write queued before it', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const order: string[] = [];
    const updateSnapshot = jest.fn((snap: GlanceableSnapshot) => {
      order.push(snap.lastResult ?? `cleared:${snap.status}`);
    });
    const load = async () => fakeTarget(updateSnapshot);

    const written = writeWidgetSnapshot(snapshot({ lastResult: 'Deployed the fix' }), load, absentAndroid);
    const cleared = clearWidgetSnapshot(absentAndroid, load);
    await Promise.all([written, cleared]);

    // A write landing after the clear would describe the gateway the app has
    // already forgotten, so the clear is last on the one serial queue.
    expect(order).toEqual(['Deployed the fix', 'cleared:disconnected']);
  });

  test('a target that throws is not retried, and the merge base still goes', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await keyValueStorage.setItem(WIDGET_LAST_PAYLOAD_KEY, JSON.stringify({ v: 3 }));
    const load = async () =>
      fakeTarget(
        jest.fn(() => {
          throw new Error('Native write failed');
        }),
      );

    await expect(clearWidgetSnapshot(absentAndroid, load)).resolves.toBeUndefined();
    expect(await readLastWidgetPayload()).toBeNull();
  });

  test('a build with no iOS target still forgets the merge base', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await keyValueStorage.setItem(WIDGET_LAST_PAYLOAD_KEY, JSON.stringify({ v: 3 }));
    const load = async (): Promise<WidgetTarget> => {
      throw new Error('Cannot find native module ExpoWidgets');
    };

    await expect(clearWidgetSnapshot(absentAndroid, load)).resolves.toBeUndefined();
    expect(await readLastWidgetPayload()).toBeNull();
  });
});

describe('clearing on Android', () => {
  test('uses the native clear and never touches the iOS target', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const clearPayload = jest.fn(async () => undefined);
    const loadAndroid = async () =>
      ({ setPayload: jest.fn(), clearPayload }) as unknown as AndroidWidgetModule;
    const updateSnapshot = jest.fn();
    const load = jest.fn(async () => fakeTarget(updateSnapshot));

    await clearWidgetSnapshot(loadAndroid, load);

    expect(clearPayload).toHaveBeenCalledTimes(1);
    expect(updateSnapshot).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

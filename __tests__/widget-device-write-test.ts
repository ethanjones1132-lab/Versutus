// The device seam is where the widget is actually written, and it answers the
// write: `setPayload` refuses a payload the card could not draw, a build with no
// widget module refuses everything, and neither is the app's own failure. The
// gate upstream can only charge an ACCEPTED write against its floor if the seam
// says so.
//
// Ordering is the same seam's job. Two fact changes inside one `import()` window
// are two native hops with nothing imposing an order between them, so the card
// could be left holding the OLDER snapshot with the newer stamp discarded.

import { Platform } from 'react-native';

import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import { keyValueStorage } from '@/lib/storage/key-value';
import {
  clearWidgetSnapshot,
  readLastWidgetPayload,
  WIDGET_LAST_PAYLOAD_KEY,
  writeWidgetSnapshot,
  type AndroidWidgetModule,
} from '@/lib/widget/widget-device';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const NOW = 1_757_400_000_000;

function snapshot(overrides: Partial<GlanceableSnapshot> = {}): GlanceableSnapshot {
  return { status: 'connected', runsInFlight: 0, approvalsPending: 0, writtenAt: NOW, ...overrides };
}

function fakeModule(setPayload: jest.Mock): AndroidWidgetModule {
  return { setPayload, clearPayload: jest.fn(async () => undefined) } as unknown as AndroidWidgetModule;
}

beforeEach(async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  await keyValueStorage.removeItem(WIDGET_LAST_PAYLOAD_KEY);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the seam answers every write', () => {
  test('an accepted write is true, and the payload it wrote is kept for the merge', async () => {
    const setPayload = jest.fn(async () => true);
    const snap = snapshot({ lastResult: 'Deployed the fix' });

    await expect(writeWidgetSnapshot(snap, undefined, async () => fakeModule(setPayload))).resolves
      .toBe(true);

    // Exactly the JSON the card was handed, so the push merge can build on it.
    expect(await readLastWidgetPayload()).toBe(JSON.stringify(androidWidgetPayload(snap)));
  });

  test('a native module that refuses the payload is false, and nothing is kept', async () => {
    const setPayload = jest.fn(async () => false);

    await expect(
      writeWidgetSnapshot(snapshot(), undefined, async () => fakeModule(setPayload)),
    ).resolves.toBe(false);
    expect(await readLastWidgetPayload()).toBeNull();
  });

  test('a build with no widget module is false, not a silent success', async () => {
    // A build with no native module THROWS on the import itself, which is what
    // `loadAndroidWidgetModule` catches; `module?.setPayload` used to make the
    // resulting no-op report nothing at all.
    const absent = async (): Promise<AndroidWidgetModule> => {
      throw new Error('Cannot find native module VersutusWidget');
    };
    await expect(writeWidgetSnapshot(snapshot(), undefined, absent)).resolves.toBe(false);
    expect(await readLastWidgetPayload()).toBeNull();
  });

  test('a write that throws is false, and the stored payload is left alone', async () => {
    await keyValueStorage.setItem(WIDGET_LAST_PAYLOAD_KEY, JSON.stringify({ v: 3, writtenAt: 1 }));
    const setPayload = jest.fn(async () => {
      throw new Error('Native write failed');
    });

    await expect(
      writeWidgetSnapshot(snapshot(), undefined, async () => fakeModule(setPayload)),
    ).resolves.toBe(false);
    expect(JSON.parse((await readLastWidgetPayload()) ?? 'null')).toEqual({ v: 3, writtenAt: 1 });
  });
});

describe('writes are serialised, latest wins', () => {
  /** A promise plus the handle that releases it, created before anything parks. */
  function gate(): { wait: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('two writes inside one import window reach the card in call order', async () => {
    const parked = gate();
    const seen: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const setPayload = jest.fn(async (json: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if ((JSON.parse(json) as { writtenAt: number }).writtenAt === NOW) await parked.wait;
      seen.push((JSON.parse(json) as { writtenAt: number }).writtenAt);
      inFlight -= 1;
      return true;
    });

    const loadAndroid = async () => fakeModule(setPayload);
    const first = writeWidgetSnapshot(snapshot({ writtenAt: NOW }), undefined, loadAndroid);
    const second = writeWidgetSnapshot(snapshot({ writtenAt: NOW + 1000 }), undefined, loadAndroid);
    await flush();
    expect(seen).toEqual([]);

    parked.open();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    // Two native `AsyncFunction` hops have no order between them: without the
    // queue the slow older write could land last and leave the card on the older
    // snapshot, with the newer stamp discarded.
    expect(seen).toEqual([NOW, NOW + 1000]);
    expect(peak).toBe(1);
  });

  test('a snapshot superseded before it starts is refused without being written', async () => {
    const parked = gate();
    const setPayload = jest.fn(async (_json: string) => true);
    const loadAndroid = async () => {
      const module = fakeModule(setPayload);
      await parked.wait;
      return module;
    };

    const first = writeWidgetSnapshot(snapshot({ writtenAt: NOW }), undefined, loadAndroid);
    const middle = writeWidgetSnapshot(snapshot({ writtenAt: NOW + 1000 }), undefined, loadAndroid);
    const newest = writeWidgetSnapshot(snapshot({ writtenAt: NOW + 2000 }), undefined, loadAndroid);
    parked.open();

    // The middle snapshot never reached the card and says so, so the caller can
    // retry it instead of charging it against the floor.
    await expect(middle).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    await expect(newest).resolves.toBe(true);
    expect(setPayload.mock.calls.map(([json]) => (JSON.parse(json) as { writtenAt: number }).writtenAt)).toEqual([
      NOW,
      NOW + 2000,
    ]);
  });
});

describe('clearWidgetSnapshot', () => {
  test('forgets the card and the merge base together', async () => {
    const clearPayload = jest.fn(async () => undefined);
    await keyValueStorage.setItem(WIDGET_LAST_PAYLOAD_KEY, JSON.stringify({ v: 3 }));

    await clearWidgetSnapshot(
      async () => ({ setPayload: jest.fn(), clearPayload }) as unknown as AndroidWidgetModule,
    );

    expect(clearPayload).toHaveBeenCalledTimes(1);
    expect(await readLastWidgetPayload()).toBeNull();
  });

  test('a write still waiting cannot land after the clear that retires it', async () => {
    const order: string[] = [];
    const loadAndroid = async () =>
      ({
        setPayload: jest.fn(async (json: string) => {
          order.push(`write:${(JSON.parse(json) as { writtenAt: number }).writtenAt}`);
          return true;
        }),
        clearPayload: jest.fn(async () => {
          order.push('clear');
        }),
      }) as unknown as AndroidWidgetModule;

    const pending = writeWidgetSnapshot(snapshot({ writtenAt: NOW }), undefined, loadAndroid);
    const cleared = clearWidgetSnapshot(loadAndroid);
    await Promise.all([pending, cleared]);

    // A payload written after the clear would describe a gateway that is gone.
    expect(order).toEqual([`write:${NOW}`, 'clear']);
  });

  test('a build with no widget module still forgets the merge base', async () => {
    await keyValueStorage.setItem(WIDGET_LAST_PAYLOAD_KEY, JSON.stringify({ v: 3 }));
    const absent = async (): Promise<AndroidWidgetModule> => {
      throw new Error('Cannot find native module VersutusWidget');
    };

    await expect(clearWidgetSnapshot(absent)).resolves.toBeUndefined();
    expect(await readLastWidgetPayload()).toBeNull();
  });
});

// A companion push and the app's own snapshot are not versions of one another.
// The snapshot says everything the card should draw; the push carries ONE fact
// (the work line, an approval count) that the Gate will never send again. Queued
// as the same kind, the snapshot coalescer treated each as the other's newest
// version: a snapshot arriving behind a queued push cancelled it, and a push
// arriving behind a queued snapshot cancelled that. Either way a fact the card
// could never recover was dropped into a `false` the caller had no retry for.
//
// These cases pin the split — a queued push keeps its own place in the queue —
// while keeping the coalescing that is still honest: two queued SNAPSHOTS both
// say everything, so the older one is refused rather than written late.
//
// `widget-device-write-test.ts` and `widget-push-task-test.ts` cover the seam and
// the merge; this file pins the queue's kinds through both entry points, the
// device's `enqueueWidgetPush` and the headless task's `handleWidgetPush`.

import { Platform } from 'react-native';

import { keyValueStorage } from '@/lib/storage/key-value';
import {
  enqueueWidgetPush,
  WIDGET_LAST_PAYLOAD_KEY,
  writeWidgetSnapshot,
  type AndroidWidgetModule,
} from '@/lib/widget/widget-device';
import { handleWidgetPush } from '@/lib/widget/widget-push-task';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));
jest.mock('expo-notifications', () => ({ registerTaskAsync: jest.fn(async () => undefined) }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const NOW = 1_757_400_000_000;

function snapshot(writtenAt: number, overrides: Partial<GlanceableSnapshot> = {}): GlanceableSnapshot {
  return { status: 'connected', runsInFlight: 0, approvalsPending: 0, writtenAt, ...overrides };
}

/** A companion message: the Gate's new work line and nothing else it can see. */
const COMPANION = { v: 2, work: '2 runs in flight', approvalsPending: 1, writtenAt: NOW + 2000 };

/** A promise plus the handles that park a native hop and release it again. */
function barrier(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function fakeModule(setPayload: jest.Mock): AndroidWidgetModule {
  return { setPayload, clearPayload: jest.fn(async () => undefined) } as unknown as AndroidWidgetModule;
}

/** The payload the module was handed by the last write in this test. */
function writtenPayload(setPayload: jest.Mock): Record<string, unknown> {
  return JSON.parse((setPayload.mock.calls.at(-1)?.[0] ?? 'null') as string) as Record<string, unknown>;
}

beforeEach(async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  await keyValueStorage.removeItem(WIDGET_LAST_PAYLOAD_KEY);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('a snapshot queued behind a companion push does not cancel the push', async () => {
  const entered = barrier();
  const release = barrier();
  const order: string[] = [];
  const appSetPayload = jest.fn(async (json: string) => {
    const { writtenAt } = JSON.parse(json) as { writtenAt: number };
    if (writtenAt === NOW) {
      entered.open();
      await release.wait;
    }
    order.push(`snapshot:${writtenAt}`);
    return true;
  });
  const pushSetPayload = jest.fn(async (_json: string) => {
    order.push('push');
    return true;
  });

  const first = writeWidgetSnapshot(snapshot(NOW), undefined, async () => fakeModule(appSetPayload));
  await entered.wait;
  // The push has to wait behind the snapshot in flight; the snapshot that
  // arrives after it must not be allowed to replace it.
  const push = handleWidgetPush({ widget: COMPANION }, async () => fakeModule(pushSetPayload));
  const later = writeWidgetSnapshot(
    snapshot(NOW + 3000),
    undefined,
    async () => fakeModule(appSetPayload),
  );
  release.open();

  await expect(first).resolves.toBe(true);
  await expect(push).resolves.toBe(true);
  await expect(later).resolves.toBe(true);

  // The push's fact reached the card exactly once, on its own turn.
  expect(pushSetPayload).toHaveBeenCalledTimes(1);
  expect(writtenPayload(pushSetPayload)).toMatchObject({
    work: COMPANION.work,
    writtenAt: COMPANION.writtenAt,
  });
  expect(order).toEqual([`snapshot:${NOW}`, 'push', `snapshot:${NOW + 3000}`]);
});

test('a companion push queued behind a snapshot does not cancel that snapshot', async () => {
  const entered = barrier();
  const release = barrier();
  const order: string[] = [];
  const appSetPayload = jest.fn(async (json: string) => {
    const { writtenAt } = JSON.parse(json) as { writtenAt: number };
    if (writtenAt === NOW) {
      entered.open();
      await release.wait;
    }
    order.push(`snapshot:${writtenAt}`);
    return true;
  });
  const pushSetPayload = jest.fn(async (_json: string) => {
    order.push('push');
    return true;
  });

  const first = writeWidgetSnapshot(snapshot(NOW), undefined, async () => fakeModule(appSetPayload));
  await entered.wait;
  const queuedSnapshot = writeWidgetSnapshot(
    snapshot(NOW + 1000),
    undefined,
    async () => fakeModule(appSetPayload),
  );
  const push = handleWidgetPush({ widget: COMPANION }, async () => fakeModule(pushSetPayload));
  release.open();

  await expect(first).resolves.toBe(true);
  // `false` here means the card never took the snapshot — a write the caller
  // would have to retry, for a snapshot nothing later carries.
  await expect(queuedSnapshot).resolves.toBe(true);
  await expect(push).resolves.toBe(true);

  expect(order).toEqual([`snapshot:${NOW}`, `snapshot:${NOW + 1000}`, 'push']);
});

test('queued snapshots still coalesce with each other, without touching a queued push', async () => {
  const entered = barrier();
  const release = barrier();
  const order: string[] = [];
  const writtenAtOf = (json: string) => (JSON.parse(json) as { writtenAt: number }).writtenAt;
  const appSetPayload = jest.fn(async (json: string) => {
    const writtenAt = writtenAtOf(json);
    if (writtenAt === NOW) {
      entered.open();
      await release.wait;
    }
    order.push(`snapshot:${writtenAt}`);
    return true;
  });

  const first = writeWidgetSnapshot(snapshot(NOW), undefined, async () => fakeModule(appSetPayload));
  await entered.wait;
  const push = enqueueWidgetPush(async () => {
    order.push('push');
    return true;
  });
  const superseded = writeWidgetSnapshot(
    snapshot(NOW + 1000),
    undefined,
    async () => fakeModule(appSetPayload),
  );
  const newest = writeWidgetSnapshot(
    snapshot(NOW + 2000),
    undefined,
    async () => fakeModule(appSetPayload),
  );
  release.open();

  await expect(first).resolves.toBe(true);
  await expect(push).resolves.toBe(true);
  // Newer snapshot wins: the middle one is refused instead of landing late.
  await expect(superseded).resolves.toBe(false);
  await expect(newest).resolves.toBe(true);

  expect(order).toEqual([`snapshot:${NOW}`, 'push', `snapshot:${NOW + 2000}`]);
  expect(appSetPayload.mock.calls.map(([json]) => writtenAtOf(json as string))).toEqual([
    NOW,
    NOW + 2000,
  ]);
});

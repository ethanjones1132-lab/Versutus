import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { WIDGET_RESULT_HIDDEN_STORAGE_KEY } from '@/lib/settings/widget-privacy';
import { keyValueStorage } from '@/lib/storage/key-value';
import * as widgetDevice from '@/lib/widget/widget-device';
import { WIDGET_LAST_PAYLOAD_KEY, writeWidgetSnapshot } from '@/lib/widget/widget-device';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';
import {
  handleWidgetPush,
  mergeWidgetPushPayload,
  WIDGET_PUSH_TASK,
  widgetPayloadFromData,
} from '@/lib/widget/widget-push-task';

jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));
jest.mock('expo-notifications', () => ({ registerTaskAsync: jest.fn(async () => undefined) }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const NOW = 1_757_400_000_000;

/** A companion message: the Gate's work line and nothing else it can see. */
const COMPANION = {
  v: 2,
  status: 'Connected',
  connected: true,
  work: '1 run in flight',
  approvalsPending: 0,
  writtenAt: NOW,
};

/** What the app's own fold wrote before the push arrived. */
const APP_WRITE = {
  v: 3 as const,
  status: 'Connected',
  connected: true,
  work: 'No runs in flight',
  result: 'Deployed the fix',
  runs: [{ title: 'Sweep the floor', state: 'Running' }],
  bots: [{ id: 'scout', label: 'Scout' }],
  configBots: [
    { id: 'scout', label: 'Scout' },
    { id: 'keel', label: 'Keel' },
  ],
  routinesFailing: 1,
  routinesLate: 2,
  approvalsPending: 0,
  writtenAt: NOW - 30_000,
};

async function seedLast(payload: unknown): Promise<void> {
  await keyValueStorage.setItem(WIDGET_LAST_PAYLOAD_KEY, JSON.stringify(payload));
}

/** The payload the module was handed by the last push in this test. */
function writtenPayload(setPayload: jest.Mock): Record<string, unknown> {
  return JSON.parse((setPayload.mock.calls.at(-1)?.[0] ?? 'null') as string) as Record<string, unknown>;
}

describe('the widget push task', () => {
  beforeEach(async () => {
    await keyValueStorage.removeItem(WIDGET_LAST_PAYLOAD_KEY);
    await keyValueStorage.removeItem(WIDGET_RESULT_HIDDEN_STORAGE_KEY);
  });

  test('is registered under the name the notifier kind addresses', () => {
    expect(WIDGET_PUSH_TASK).toBe('versutus-widget-push');
  });

  test('the defined background task survives a native failure and handles the next push', async () => {
    const [name, task] = jest.mocked(TaskManager.defineTask).mock.calls[0];
    expect(name).toBe(WIDGET_PUSH_TASK);
    const setPayload = jest.fn()
      .mockRejectedValueOnce(new Error('Native write failed'))
      .mockResolvedValue(true);
    const load = jest.spyOn(widgetDevice, 'loadAndroidWidgetModule')
      .mockResolvedValue({ setPayload, clearPayload: jest.fn() } as never);
    const body = {
      data: { widget: COMPANION },
      error: null,
      executionInfo: { eventId: 'widget-push-event', taskName: WIDGET_PUSH_TASK },
    };

    try {
      await expect(task(body)).resolves.toBeUndefined();
      await expect(task(body)).resolves.toBeUndefined();
      expect(setPayload).toHaveBeenCalledTimes(2);
      expect(TaskManager.defineTask).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });

  test('a message with no widget key carries no payload', () => {
    expect(widgetPayloadFromData({ kind: 'routine', jobId: 'j1' })).toBeNull();
    expect(widgetPayloadFromData(null)).toBeNull();
  });

  test('a widget payload is carried through as its JSON string', () => {
    expect(JSON.parse(widgetPayloadFromData({ widget: COMPANION }) ?? 'null')).toEqual(COMPANION);
  });

  test('an unavailable native module writes nothing', async () => {
    await expect(handleWidgetPush({ widget: COMPANION }, async () => null)).resolves.toBe(false);
  });

  test('a native module load failure resolves without writing', async () => {
    const load = jest.fn(async () => {
      throw new Error('Module unavailable');
    });
    await expect(handleWidgetPush({ widget: COMPANION }, load)).resolves.toBe(false);
  });

  test('a failed native write resolves and a later push can still write', async () => {
    const setPayload = jest.fn()
      .mockRejectedValueOnce(new Error('Native write failed'))
      .mockResolvedValue(true);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;
    const data = { widget: COMPANION };

    await expect(handleWidgetPush(data, load)).resolves.toBe(false);
    await expect(handleWidgetPush(data, load)).resolves.toBe(true);
    expect(setPayload).toHaveBeenCalledTimes(2);
    // The merged payload, not the message: the card keeps the roster it holds.
    expect(writtenPayload(setPayload).bots).toBeUndefined();
    expect(writtenPayload(setPayload).work).toBe(COMPANION.work);
  });

  test('a valid message is written to the Glance module; an absent one writes nothing', async () => {
    const setPayload = jest.fn(async () => true);
    const load = jest.fn(async () => ({ setPayload, clearPayload: jest.fn() }) as never);

    await expect(handleWidgetPush({ widget: COMPANION }, load)).resolves.toBe(true);
    expect(writtenPayload(setPayload)).toMatchObject({
      status: 'Disconnected',
      connected: false,
      work: COMPANION.work,
      writtenAt: COMPANION.writtenAt,
    });

    setPayload.mockClear();
    await expect(handleWidgetPush({ kind: 'reply' }, load)).resolves.toBe(false);
    expect(setPayload).not.toHaveBeenCalled();
  });

  test('a message the card could never draw writes nothing at all', async () => {
    const setPayload = jest.fn(async () => true);
    const load = jest.fn(async () => ({ setPayload, clearPayload: jest.fn() }) as never);

    // `WidgetPayload.parse` refuses a blank work line and a stamp of zero, and a
    // refusal must not replace the last good payload the card is still stamping.
    await expect(handleWidgetPush({ widget: { v: 2 } }, load)).resolves.toBe(false);
    expect(setPayload).not.toHaveBeenCalled();
  });
});

// The companion is a whole-payload write, so forwarding it verbatim erases
// everything the JSON does not name: the roster, the run rows, the pinned Bot's
// name and the privacy flag all parse as EMPTY, not unchanged.
describe('a companion message merges onto the payload the app last wrote', () => {
  beforeEach(async () => {
    await keyValueStorage.removeItem(WIDGET_LAST_PAYLOAD_KEY);
    await keyValueStorage.removeItem(WIDGET_RESULT_HIDDEN_STORAGE_KEY);
  });

  test('the roster, the run rows and the tallies survive the push', async () => {
    await seedLast(APP_WRITE);
    const setPayload = jest.fn(async () => true);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;

    await expect(handleWidgetPush({ widget: COMPANION }, load)).resolves.toBe(true);

    const merged = writtenPayload(setPayload);
    expect(merged.bots).toEqual(APP_WRITE.bots);
    expect(merged.configBots).toEqual(APP_WRITE.configBots);
    expect(merged.runs).toEqual(APP_WRITE.runs);
    expect(merged.routinesFailing).toBe(1);
    expect(merged.routinesLate).toBe(2);
    // The work line and the approval count are the push's own; the stamp is the
    // newer of the two writes (the push here lands 30 s after the app write).
    expect(merged.work).toBe(COMPANION.work);
    expect(merged.writtenAt).toBe(COMPANION.writtenAt);
    expect(merged.approvalsPending).toBe(COMPANION.approvalsPending);
    expect(merged.v).toBe(3);
  });

  test('a hidden result is kept off the card and redaction is stated', async () => {
    await seedLast(APP_WRITE);
    await keyValueStorage.setItem(WIDGET_RESULT_HIDDEN_STORAGE_KEY, 'true');
    const setPayload = jest.fn(async () => true);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;

    await expect(
      handleWidgetPush({ widget: { ...COMPANION, result: 'Secret deploy output' } }, load),
    ).resolves.toBe(true);

    const merged = writtenPayload(setPayload);
    expect(merged.result).toBeUndefined();
    expect(merged.redact).toBe(true);
    expect(merged.bots).toBeUndefined();
    expect(merged.configBots).toBeUndefined();
    // The counts and the honest stamp stay: they are not names.
    expect(merged.approvalsPending).toBe(0);
    expect(merged.writtenAt).toBe(COMPANION.writtenAt);
  });

  test('a visible result is written, because this device has not hidden it', async () => {
    await seedLast(APP_WRITE);
    const setPayload = jest.fn(async () => true);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;

    await expect(
      handleWidgetPush({ widget: { ...COMPANION, result: 'Deployed the fix' } }, load),
    ).resolves.toBe(true);

    const merged = writtenPayload(setPayload);
    expect(merged.result).toBe('Deployed the fix');
    expect(merged.redact).toBeUndefined();
    expect(merged.bots).toEqual(APP_WRITE.bots);
  });

  test('the push carries no connection claim, so only a fresh app write speaks for the link', async () => {
    const fresh = mergeWidgetPushPayload(COMPANION, APP_WRITE, false, NOW);
    expect(fresh).toMatchObject({ connected: true, status: 'Connected' });
    // Five minutes is the gate's own window for "the app still knows".
    const stale = mergeWidgetPushPayload(COMPANION, APP_WRITE, false, NOW + 5 * 60 * 1000);
    expect(stale).toMatchObject({ connected: false, status: 'Disconnected' });
    // No app write at all: the app has said nothing, so the card must not either.
    expect(mergeWidgetPushPayload(COMPANION, null, false, NOW)).toMatchObject({
      connected: false,
      status: 'Disconnected',
    });
  });

  test('a stale last write yields a disconnected card even though the Gate claims connected', async () => {
    await seedLast({ ...APP_WRITE, connected: true, writtenAt: NOW - 6 * 60 * 1000 });
    const setPayload = jest.fn(async () => true);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;

    await expect(handleWidgetPush({ widget: COMPANION }, load)).resolves.toBe(true);

    // The companion asserted `connected: true`; the phone has no reading of its
    // own link to back it, so the app's own word is the only honest one.
    expect(writtenPayload(setPayload)).toMatchObject({ connected: false, status: 'Disconnected' });
  });

  test('with no last payload the message alone is written, still privacy filtered', async () => {
    await keyValueStorage.setItem(WIDGET_RESULT_HIDDEN_STORAGE_KEY, 'true');
    const setPayload = jest.fn(async () => true);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;

    await expect(
      handleWidgetPush({ widget: { ...COMPANION, result: 'Secret deploy output' } }, load),
    ).resolves.toBe(true);

    const merged = writtenPayload(setPayload);
    expect(merged).toMatchObject({ v: 3, connected: false, status: 'Disconnected', work: COMPANION.work });
    expect(merged.result).toBeUndefined();
    expect(merged.redact).toBe(true);
    expect(merged.bots).toBeUndefined();
  });

  test('a refused write is reported false and leaves the stored base alone', async () => {
    await seedLast(APP_WRITE);
    const setPayload = jest.fn(async () => false);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;

    await expect(handleWidgetPush({ widget: COMPANION }, load)).resolves.toBe(false);
    expect(setPayload).toHaveBeenCalledTimes(1);
    // The card refused it, so it is not the next merge's base.
    expect(JSON.parse((await keyValueStorage.getItem(WIDGET_LAST_PAYLOAD_KEY)) ?? 'null')).toEqual(APP_WRITE);
  });

  test('what the card took becomes the next merge base', async () => {
    await seedLast(APP_WRITE);
    const setPayload = jest.fn(async () => true);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;

    await handleWidgetPush({ widget: COMPANION }, load);

    expect(JSON.parse((await keyValueStorage.getItem(WIDGET_LAST_PAYLOAD_KEY)) ?? 'null')).toEqual(
      writtenPayload(setPayload),
    );
  });

  test('a future stamp is not trusted: a fresh connected write does not stay connected forever', () => {
    // The Gate stamps with the PC's clock. If that clock is ahead of the
    // phone's, `now - last.writtenAt` is negative and every freshness test reads
    // "young" forever, carrying `connected: true` forward from a write of
    // unknown age — the one overclaim this module forbids.
    const future = { ...APP_WRITE, writtenAt: NOW + 10 * 60 * 1000 };
    const merged = mergeWidgetPushPayload(COMPANION, future, false, NOW);
    expect(merged).toMatchObject({ connected: false, status: 'Disconnected' });
    // The gate's own floor still stands for a stamp that is not in the future.
    expect(mergeWidgetPushPayload(COMPANION, APP_WRITE, false, NOW)).toMatchObject({ connected: true });
  });

  test('a push older than the app write never overwrites the newer work line', () => {
    // Doze delays a data-only push, so a companion generated before the app's
    // last write can arrive after it. The newer app write is the truth.
    const newerApp = { ...APP_WRITE, work: '1 run in flight', writtenAt: NOW };
    const olderPush = { ...COMPANION, work: 'No runs in flight', writtenAt: NOW - 60_000 };
    const merged = mergeWidgetPushPayload(olderPush, newerApp, false, NOW);
    expect(merged).toMatchObject({ work: '1 run in flight', writtenAt: NOW });
  });

  test('concurrent app and push writes reach the card in one serial order', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await seedLast(APP_WRITE);
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const setPayload = jest.fn(async (json: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(json);
      // Hold the native hop open across a timer tick: both writers reach here
      // on microtasks alone, so a window that closed sooner would be over before
      // the second call could ever overlap it and the serialisation would go
      // unasserted.
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return true;
    });
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;
    // Rows this write alone carries: the seeded base and the companion both say
    // "Sweep the floor", so whichever payload the card is left holding is
    // unambiguous — the newer app write, or the one merged from the older base.
    const snapshot: GlanceableSnapshot = {
      status: 'connected',
      runsInFlight: 0,
      runs: [{ title: 'Bake bread', state: 'Running' }],
      approvalsPending: 0,
      writtenAt: NOW + 1000,
    };

    // The app's own snapshot write and the headless push's write start in the
    // same tick. Only the queue can impose an order between the two native hops.
    const [, pushWrote] = await Promise.all([
      writeWidgetSnapshot(snapshot, undefined, load as never),
      handleWidgetPush({ widget: COMPANION }, load),
    ]);

    expect(pushWrote).toBe(true);
    expect(order).toHaveLength(2);
    // One native hop at a time: two unqueued writers both reach `setPayload`
    // while the first is still in flight, which is the whole hazard.
    expect(peak).toBe(1);
    // The card is left holding the newer app write: the last payload it took
    // carries that write's rows and stamp, not the seeded base's.
    const held = JSON.parse(order.at(-1) ?? 'null') as {
      runs?: { title: string; state: string }[];
      writtenAt: number;
    };
    expect(held.runs).toEqual(snapshot.runs);
    expect(held.writtenAt).toBe(NOW + 1000);
    // …and what the card took is the next merge's base: the read-modify-write
    // runs inside the same queued job rather than beside it.
    expect(JSON.parse((await keyValueStorage.getItem(WIDGET_LAST_PAYLOAD_KEY)) ?? 'null')).toEqual(
      held,
    );
  });
});

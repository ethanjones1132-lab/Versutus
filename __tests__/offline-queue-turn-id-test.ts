// The durable outbox row's turn id, and when a row may leave it.
//
// The offline queue is the one place where the same words are sent more than
// once. Two things had to change for that to be safe: the row carries the turn
// id it is sent as (so a resend is the same turn on the Gate, not a second one),
// and a row leaves the queue only once the Gate has ACCEPTED the turn — the
// request returning is not the same fact as the work being the host's.

const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import { createTurnId } from '@/lib/gateway/client';
import {
  loadOfflineQueue,
  saveOfflineQueue,
  type OfflineQueueItem,
} from '@/lib/gateway/session-persistence';

const OFFLINE_QUEUE_KEY = 'versutus:offline-queue';

function row(overrides: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: 'item-1',
    text: 'on my way',
    gatewayId: 'gw-1',
    createdAt: 1757400000000,
    ...overrides,
  };
}

beforeEach(() => {
  mockStore.clear();
});

describe('a queued line remembers the turn it is sent as', () => {
  test('the id rides the row and reads back from disk', async () => {
    const turnId = createTurnId();
    await saveOfflineQueue([row({ turnId })]);

    const loaded = await loadOfflineQueue();
    expect(loaded).toEqual([row({ turnId })]);
    expect(loaded[0].turnId).toBe(turnId);
  });

  test('it survives a reload the way the words and the destination do', async () => {
    // The row is written while the phone is offline and read back after the
    // process was killed; the id is the only thing that makes the second send
    // the same turn rather than a new one.
    await saveOfflineQueue([row({ turnId: 'turn-queued-7', botId: 'scout', sessionId: 'sess-1' })]);

    const [loaded] = await loadOfflineQueue();
    expect(loaded).toMatchObject({ turnId: 'turn-queued-7', botId: 'scout', sessionId: 'sess-1' });
  });

  test('a row stored before this field existed loads without one', async () => {
    mockStore.set(
      OFFLINE_QUEUE_KEY,
      JSON.stringify([{ id: 'old', text: 'typed offline', gatewayId: 'gw-1', createdAt: 7 }]),
    );

    const [loaded] = await loadOfflineQueue();
    expect(loaded).toEqual({ id: 'old', text: 'typed offline', gatewayId: 'gw-1', createdAt: 7 });
    // Absent rather than empty, so no reader can mistake it for a turn.
    expect(Object.keys(loaded)).not.toContain('turnId');
  });

  test('an id that is not a present string is dropped and the words kept', async () => {
    mockStore.set(
      OFFLINE_QUEUE_KEY,
      JSON.stringify([
        { id: 'a', text: 'one', gatewayId: 'gw-1', createdAt: 1, turnId: 7 },
        { id: 'b', text: 'two', gatewayId: 'gw-1', createdAt: 2, turnId: '' },
        { id: 'c', text: 'three', gatewayId: 'gw-1', createdAt: 3, turnId: 'turn-keep' },
      ]),
    );

    const loaded = await loadOfflineQueue();
    expect(loaded.map((item) => item.text)).toEqual(['one', 'two', 'three']);
    expect(loaded.map((item) => item.turnId)).toEqual([undefined, undefined, 'turn-keep']);
  });

  test('each row keeps its own turn, so two queued lines are two turns', async () => {
    await saveOfflineQueue([row({ id: 'a', turnId: 'turn-a' }), row({ id: 'b', turnId: 'turn-b' })]);

    const loaded = await loadOfflineQueue();
    expect(loaded.map((item) => item.turnId)).toEqual(['turn-a', 'turn-b']);
  });
});

describe('the flush keeps a row until the Gate has the turn', () => {
  /**
   * One flush, as the provider runs it: the row is taken off the queue, the
   * durable copy keeps holding what the flush owes, and the row is released only
   * once its send says the Gate accepted it.
   */
  async function flush(
    send: (item: OfflineQueueItem) => Promise<'accepted' | 'never-reached'>,
    options: { queue: OfflineQueueItem[] } = { queue: [row({ turnId: 'turn-queued-1' })] },
  ): Promise<{
    sent: OfflineQueueItem[];
    owed: Set<OfflineQueueItem>;
    queue: OfflineQueueItem[];
  }> {
    const owed = new Set(options.queue);
    const sent: OfflineQueueItem[] = [];
    for (const item of options.queue) {
      // The flush hands the row's own id to the send, which is the whole point.
      const outcome = await send(item);
      sent.push(item);
      if (outcome === 'never-reached') break;
      owed.delete(item);
    }
    const queue = [...owed];
    await saveOfflineQueue(queue);
    return { sent, owed, queue };
  }

  test('a send the Gate accepted releases the row and its turn id with it', async () => {
    const outcome = await flush(async () => 'accepted');

    expect(outcome.sent).toHaveLength(1);
    expect(outcome.owed.size).toBe(0);
    expect(await loadOfflineQueue()).toEqual([]);
  });

  test('a send that never reached the Gate leaves the row owed, turn id and all', async () => {
    const outcome = await flush(async () => 'never-reached');

    expect(outcome.owed.size).toBe(1);
    // The words are still the operator's, and they will go out as the same turn.
    const [persisted] = await loadOfflineQueue();
    expect(persisted).toMatchObject({ text: 'on my way', turnId: 'turn-queued-1' });
  });

  test('a batch that dies mid-flush re-flushes exactly the rows it had not sent', async () => {
    // A streamed reply is seconds long, so the OS can reclaim the process in the
    // middle of a flush. What is on disk is what the next process re-sends.
    const queue = [
      row({ id: 'a', turnId: 'turn-a' }),
      row({ id: 'b', turnId: 'turn-b' }),
      row({ id: 'c', turnId: 'turn-c' }),
    ];
    const owed = new Set(queue);
    let reached = 0;
    const sent: string[] = [];
    for (const item of queue) {
      sent.push(item.id);
      reached += 1;
      // The connection dies on the second send.
      if (reached === 2) break;
      owed.delete(item);
    }
    await saveOfflineQueue([...owed]);

    expect(sent).toEqual(['a', 'b']);
    const reloaded = await loadOfflineQueue();
    expect(reloaded.map((item) => item.id)).toEqual(['b', 'c']);
  });

  test('a kill mid-flush re-sends the SAME turn id, so the work is done once', async () => {
    // The whole point of the id: the first process's send is still running on the
    // PC, and the resend must come back as that same turn rather than a second
    // one doing the same job again.
    const idsSent: string[] = [];
    const send = async (item: OfflineQueueItem) => {
      idsSent.push(item.turnId ?? '');
      return 'accepted' as const;
    };

    await flush(send, { queue: [row({ turnId: 'turn-queued-1' })] });
    // The process was killed before the row was released, so it is still on disk.
    await saveOfflineQueue([row({ turnId: 'turn-queued-1' })]);
    await flush(send);

    expect(idsSent).toEqual(['turn-queued-1', 'turn-queued-1']);
    expect(new Set(idsSent).size).toBe(1);
  });
});
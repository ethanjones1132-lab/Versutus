// ─── Council rooms: an abandoned round must not leave the operator's words ──
// Create and delete are paired inside one async function, and a process the OS
// reclaims mid-round never runs the second half. So the room is named without
// the prompt, and the intent to delete it is written down the moment it exists
// and swept on the next connected mount. Nothing here may throw: a storage
// refusal is a lost ledger entry, never a failed comparison.

import {
  boundedOperation,
  clearPendingRoom,
  COUNCIL_NO_ANSWER_COPY,
  COUNCIL_PENDING_ROOMS_KEY,
  COUNCIL_ROOM_LEAK_MS,
  COUNCIL_ROOM_PREFIX,
  councilNoAnswerColumns,
  councilRoomGone,
  councilRoomName,
  forgetPendingRooms,
  isStalePendingRoom,
  notePendingRoom,
  parsePendingRooms,
  rememberPendingRoom,
  stalePendingRooms,
  sweepPendingRooms,
  type CouncilPendingRoom,
  type CouncilRoomLedger,
} from '@/lib/gateway/council';
import { GatewayHttpError } from '@/lib/gateway/errors';

const T0 = 1_700_000_000_000;

function fakeLedger() {
  const rows = new Map<string, string>();
  const store: CouncilRoomLedger = {
    getItem: jest.fn(async (key: string) => rows.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      rows.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      rows.delete(key);
    }),
  };
  return { store, rows };
}

function stored(rows: Map<string, string>): CouncilPendingRoom[] {
  return parsePendingRooms(rows.get(COUNCIL_PENDING_ROOMS_KEY) ?? null);
}

describe('a council room is never named after the prompt', () => {
  test('it is the prefix plus a short token, so a leaked room carries nothing typed', () => {
    const name = councilRoomName();
    expect(name.startsWith(COUNCIL_ROOM_PREFIX)).toBe(true);
    expect(name.slice(COUNCIL_ROOM_PREFIX.length)).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe('the pending-room ledger', () => {
  test('a round killed after create leaves a record the next mount deletes', async () => {
    const { store, rows } = fakeLedger();
    const deleteRoom = jest.fn(async () => ({ ok: true }));

    await notePendingRoom(store, 'room-1', T0);
    expect(stored(rows)).toEqual([{ roomId: 'room-1', createdAt: T0 }]);

    await sweepPendingRooms(store, deleteRoom, T0 + COUNCIL_ROOM_LEAK_MS);
    expect(deleteRoom).toHaveBeenCalledTimes(1);
    expect(deleteRoom).toHaveBeenCalledWith('room-1');
    expect(rows.has(COUNCIL_PENDING_ROOMS_KEY)).toBe(false);
  });

  test('a record younger than the bound is a live round and is left alone', async () => {
    const { store, rows } = fakeLedger();
    const deleteRoom = jest.fn(async () => ({ ok: true }));

    await notePendingRoom(store, 'room-1', T0);
    await sweepPendingRooms(store, deleteRoom, T0 + 1_000);
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(stored(rows)).toEqual([{ roomId: 'room-1', createdAt: T0 }]);

    // The same record is collectable once it can only be a leftover.
    expect(isStalePendingRoom({ roomId: 'room-1', createdAt: T0 }, T0 + COUNCIL_ROOM_LEAK_MS - 1)).toBe(false);
    expect(isStalePendingRoom({ roomId: 'room-1', createdAt: T0 }, T0 + COUNCIL_ROOM_LEAK_MS)).toBe(true);
  });

  test('a delete that fails keeps its record, and the next sweep tries again', async () => {
    const { store, rows } = fakeLedger();
    const refused = jest.fn(async () => {
      throw new Error('Request timed out: DELETE /v1/bot-groups/room-1');
    });

    await notePendingRoom(store, 'room-1', T0);
    await expect(sweepPendingRooms(store, refused, T0 + COUNCIL_ROOM_LEAK_MS)).resolves.toBeUndefined();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(stored(rows)).toEqual([{ roomId: 'room-1', createdAt: T0 }]);

    const second = jest.fn(async () => ({ ok: true }));
    await sweepPendingRooms(store, second, T0 + 2 * COUNCIL_ROOM_LEAK_MS);
    expect(second).toHaveBeenCalledWith('room-1');
    expect(rows.has(COUNCIL_PENDING_ROOMS_KEY)).toBe(false);
  });

  test('a room the Gate has already forgotten settles the record like a success', async () => {
    const missing = jest.fn(async () => {
      throw new GatewayHttpError('no such room', 404);
    });
    const worded = jest.fn(async () => {
      throw new Error('Room not found');
    });

    const first = fakeLedger();
    await notePendingRoom(first.store, 'room-1', T0);
    await expect(sweepPendingRooms(first.store, missing, T0 + COUNCIL_ROOM_LEAK_MS)).resolves.toBeUndefined();
    expect(missing).toHaveBeenCalledWith('room-1');
    expect(first.rows.has(COUNCIL_PENDING_ROOMS_KEY)).toBe(false);

    const second = fakeLedger();
    await notePendingRoom(second.store, 'room-2', T0);
    await sweepPendingRooms(second.store, worded, T0 + COUNCIL_ROOM_LEAK_MS);
    expect(worded).toHaveBeenCalledWith('room-2');
    expect(second.rows.has(COUNCIL_PENDING_ROOMS_KEY)).toBe(false);
  });

  test('a delete is not the only not-found shape, and a timeout is not one', () => {
    expect(councilRoomGone(new GatewayHttpError('gone', 404))).toBe(true);
    expect(councilRoomGone(new Error('Unknown room room-1'))).toBe(true);
    expect(councilRoomGone(new Error('Request timed out: DELETE /v1/bot-groups/room-1'))).toBe(false);
    expect(councilRoomGone(new GatewayHttpError('refused', 401))).toBe(false);
  });

  test('a storage refusal costs the ledger, never the round', async () => {
    const refusing: CouncilRoomLedger = {
      getItem: async () => {
        throw new Error('SQLite row too large');
      },
      setItem: async () => {
        throw new Error('SQLite row too large');
      },
      removeItem: async () => {
        throw new Error('SQLite row too large');
      },
    };
    const deleteRoom = jest.fn(async () => ({ ok: true }));

    await expect(notePendingRoom(refusing, 'room-1', T0)).resolves.toBeUndefined();
    await expect(clearPendingRoom(refusing, 'room-1')).resolves.toBeUndefined();
    await expect(sweepPendingRooms(refusing, deleteRoom, T0 + COUNCIL_ROOM_LEAK_MS)).resolves.toBeUndefined();
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  test('an unreadable or corrupt ledger reads as an empty one', () => {
    expect(parsePendingRooms(null)).toEqual([]);
    expect(parsePendingRooms('{not json')).toEqual([]);
    expect(parsePendingRooms('{"roomId":"room-1"}')).toEqual([]);
    expect(
      parsePendingRooms(JSON.stringify([{ roomId: 'room-1', createdAt: T0 }, { roomId: '', createdAt: 1 }, 7])),
    ).toEqual([{ roomId: 'room-1', createdAt: T0 }]);
  });

  test('the ledger never grows without end or records one room twice', () => {
    let records: CouncilPendingRoom[] = [];
    for (let index = 0; index < 20; index += 1) {
      records = rememberPendingRoom(records, `room-${index}`, T0 + index);
    }
    expect(records).toHaveLength(8);
    expect(records[7]).toEqual({ roomId: 'room-19', createdAt: T0 + 19 });
    expect(rememberPendingRoom(records, 'room-19', T0 + 99)).toHaveLength(8);
    expect(forgetPendingRooms(records, ['room-19'])).not.toContainEqual(
      expect.objectContaining({ roomId: 'room-19' }),
    );
    expect(stalePendingRooms(records, T0)).toEqual([]);
  });
});

describe('the round bound is about the screen, not the request', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a bound operation gives up on its own clock', async () => {
    const bounded = boundedOperation(new Promise<never>(() => undefined), 8_000);
    jest.advanceTimersByTime(8_000);
    await expect(bounded).rejects.toThrow('Gave up after 8000ms');
  });

  test('work that lands inside the bound is the work\u2019s answer', async () => {
    const bounded = boundedOperation(Promise.resolve({ ok: true }), 8_000);
    await expect(bounded).resolves.toEqual({ ok: true });
  });

  test('a column that arrived keeps its answer; the rest say they have none', () => {
    const targets = [
      { botId: 'scout', label: 'Scout' },
      { botId: 'night', label: 'Night' },
    ];
    const columns = councilNoAnswerColumns(targets, [
      { botId: 'scout', label: 'Scout', state: 'answered', text: 'Scout says hi' },
    ]);
    expect(columns).toEqual([
      { botId: 'scout', label: 'Scout', state: 'answered', text: 'Scout says hi' },
      { botId: 'night', label: 'Night', state: 'failed', error: COUNCIL_NO_ANSWER_COPY },
    ]);
    // Nothing arrived at all: every Bot names the missing answer for itself.
    expect(councilNoAnswerColumns(targets).map((column) => column.state)).toEqual(['failed', 'failed']);
  });
});

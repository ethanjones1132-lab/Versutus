// ─── Council rooms: an abandoned round must not leave the operator's words ──
// Create and delete are paired inside one async function, and a process the OS
// reclaims mid-round never runs the second half. So the room is named without
// the prompt, and the intent to delete it is written down the moment it exists
// and swept on the next connected mount. A storage refusal must be reported,
// never treated as a durable record: the screen refuses to send a round whose
// room it could not later delete.

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }) }));
jest.mock('@/components/ui', () => ({
  Screen: 'Screen',
  Card: 'Card',
  Chip: 'Chip',
  Button: 'Button',
  Text: 'Text',
  TextField: 'TextField',
  Skeleton: 'Skeleton',
  EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard',
  PageTitle: 'PageTitle',
  PressableScale: 'PressableScale',
  Icon: 'Icon',
}));
jest.mock('@/components/chat/council-compare-view', () => ({
  CouncilCompareView: 'CouncilCompareView',
}));
jest.mock('@/context/gateway-provider', () => ({ useGateway: jest.fn() }));
// A key-value store the mounted screen really reads and writes, so a record
// kept by one mutation is still there for the next one.
let mockStore = new Map<string, string>();

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStore.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStore.delete(key);
    }),
  },
}));
// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import CouncilScreen from '@/app/council';
import { useGateway } from '@/context/gateway-provider';
import type { PublicBot } from '@/lib/gateway/bots';
import { keyValueStorage } from '@/lib/storage/key-value';

import {
  boundedOperation,
  clearPendingRoom,
  COUNCIL_NO_ANSWER_COPY,
  COUNCIL_PENDING_ROOMS_KEY,
  COUNCIL_PENDING_ROOM_CAP,
  COUNCIL_ROOM_LEAK_MS,
  COUNCIL_ROOM_PREFIX,
  COUNCIL_ROUND_TIMEOUT_MS,
  councilLedgerFullWarning,
  councilLedgerRefusalCopy,
  councilNoAnswerColumns,
  councilRoomLedger,
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

test('browser ledger exposes unavailable and refused storage instead of claiming durability', async () => {
  const native = fakeLedger().store;
  const missing = councilRoomLedger(native, () => undefined);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await expect(notePendingRoom(missing, 'missing', T0)).resolves.toEqual({ recorded: false, reason: 'unreadable' });
    const browser = councilRoomLedger(native, () => ({
      getItem: () => null,
      setItem: () => { throw new Error('storage denied'); },
      removeItem: () => undefined,
    }));
    await expect(notePendingRoom(browser, 'refused', T0)).resolves.toEqual({ recorded: false, reason: 'unwritable' });
    expect(native.setItem).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

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

  test('a hung delete cannot hold the rooms behind it, and settled rooms leave the ledger', async () => {
    jest.useFakeTimers();
    try {
      const { store, rows } = fakeLedger();
      await notePendingRoom(store, 'room-hung', T0);
      await notePendingRoom(store, 'room-ok', T0);
      const deleteRoom = jest.fn(async (roomId: string) => {
        if (roomId === 'room-hung') return new Promise<never>(() => undefined);
        return { ok: true };
      });

      const sweep = sweepPendingRooms(store, deleteRoom, T0 + COUNCIL_ROOM_LEAK_MS);
      // The first delete never resolves; its own bound must expire and let the
      // second room be attempted instead of parking the sweep forever.
      await jest.advanceTimersByTimeAsync(8_000);
      await sweep;

      expect(deleteRoom).toHaveBeenCalledWith('room-hung');
      expect(deleteRoom).toHaveBeenCalledWith('room-ok');
      // room-ok settled as it landed; the hung room's failure must not discard
      // that success the way the old all-or-nothing ledger write did.
      expect(stored(rows)).toEqual([{ roomId: 'room-hung', createdAt: T0 }]);
    } finally {
      jest.useRealTimers();
    }
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
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      // A ledger that cannot be read is a refusal, never a pretend record.
      await expect(notePendingRoom(refusing, 'room-1', T0)).resolves.toEqual({
        recorded: false,
        reason: 'unreadable',
      });
      await expect(clearPendingRoom(refusing, 'room-1')).resolves.toBeUndefined();
      await expect(sweepPendingRooms(refusing, deleteRoom, T0 + COUNCIL_ROOM_LEAK_MS)).resolves.toBeUndefined();
      expect(deleteRoom).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('a refused ledger write is reported as not recorded, and keeps every old record', async () => {
    const { store, rows } = fakeLedger();
    const owed = [
      { roomId: 'room-old', createdAt: T0 - 1 },
      { roomId: 'room-older', createdAt: T0 - 2 },
    ];
    rows.set(COUNCIL_PENDING_ROOMS_KEY, JSON.stringify(owed));
    jest.mocked(store.setItem).mockRejectedValueOnce(new Error('disk full'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(notePendingRoom(store, 'room-new', T0)).resolves.toEqual({
        recorded: false,
        reason: 'unwritable',
      });
      // The failed write did not replace the obligations already on disk.
      expect(stored(rows)).toEqual(owed);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('write was refused');
    } finally {
      warn.mockRestore();
    }
  });

  test('a refused ledger read is not treated as an empty ledger', async () => {
    const { store, rows } = fakeLedger();
    jest.mocked(store.getItem).mockRejectedValueOnce(new Error('keychain unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(notePendingRoom(store, 'room-new', T0)).resolves.toEqual({
        recorded: false,
        reason: 'unreadable',
      });
      // Reading as empty and writing the newcomer would have destroyed whatever
      // old obligations the unreadable ledger still held.
      expect(store.setItem).not.toHaveBeenCalled();
      expect(store.removeItem).not.toHaveBeenCalled();
      expect(rows.has(COUNCIL_PENDING_ROOMS_KEY)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('could not be read');
    } finally {
      warn.mockRestore();
    }
  });

  test('overlapping admissions serialise instead of dropping each other', async () => {
    const { store, rows } = fakeLedger();

    const results = await Promise.all([
      notePendingRoom(store, 'room-a', T0),
      notePendingRoom(store, 'room-b', T0 + 1),
    ]);

    expect(results).toEqual([{ recorded: true }, { recorded: true }]);
    expect(stored(rows)).toEqual([
      { roomId: 'room-a', createdAt: T0 },
      { roomId: 'room-b', createdAt: T0 + 1 },
    ]);
  });

  test('an admission overlapping a sweep keeps the newcomer and settles only the old room', async () => {
    const { store, rows } = fakeLedger();
    const owed = { roomId: 'room-old', createdAt: T0 };
    const fresh = { roomId: 'room-new', createdAt: T0 + COUNCIL_ROOM_LEAK_MS };
    rows.set(COUNCIL_PENDING_ROOMS_KEY, JSON.stringify([owed]));
    // Hold the sweep's delete open so the admission provably lands while the
    // sweep is between its read and its own ledger write.
    let releaseDelete: () => void = () => undefined;
    const deleteGap = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteRoom = jest.fn(async () => {
      await deleteGap;
      return { ok: true };
    });

    const sweep = sweepPendingRooms(store, deleteRoom, T0 + COUNCIL_ROOM_LEAK_MS);
    await expect(notePendingRoom(store, 'room-new', T0 + COUNCIL_ROOM_LEAK_MS)).resolves.toEqual({
      recorded: true,
    });
    // Both obligations coexist while the delete is still in flight: the
    // admission must not build its list from the sweep's older snapshot.
    expect(stored(rows)).toEqual([owed, fresh]);

    releaseDelete();
    await sweep;

    expect(deleteRoom).toHaveBeenCalledTimes(1);
    expect(deleteRoom).toHaveBeenCalledWith('room-old');
    // Settling the old room drops exactly that record, never the newcomer.
    expect(stored(rows)).toEqual([fresh]);
  });

  test('a malformed stored ledger is refused, not overwritten or swept', async () => {
    const shapes = [
      '{not json',
      '{"roomId":"room-1"}',
      JSON.stringify([{ roomId: 'room-1', createdAt: T0 }, 7]),
    ];

    for (const malformed of shapes) {
      const { store, rows } = fakeLedger();
      rows.set(COUNCIL_PENDING_ROOMS_KEY, malformed);
      const deleteRoom = jest.fn(async () => ({ ok: true }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        // Admission is a refusal: a shape this build cannot trust must not be
        // replaced by a newcomer, or the rooms it still names are lost forever.
        await expect(notePendingRoom(store, 'room-new', T0)).resolves.toEqual({
          recorded: false,
          reason: 'unreadable',
        });
        expect(store.setItem).not.toHaveBeenCalled();
        expect(store.removeItem).not.toHaveBeenCalled();
        expect(rows.get(COUNCIL_PENDING_ROOMS_KEY)).toBe(malformed);

        // Cleanup must not "settle" anything from a blob it could not read.
        await expect(clearPendingRoom(store, 'room-old')).resolves.toBeUndefined();
        await expect(sweepPendingRooms(store, deleteRoom, T0 + COUNCIL_ROOM_LEAK_MS)).resolves.toBeUndefined();
        expect(deleteRoom).not.toHaveBeenCalled();
        expect(rows.get(COUNCIL_PENDING_ROOMS_KEY)).toBe(malformed);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    }
  });

  test('an unreadable or corrupt ledger reads as an empty one', () => {
    expect(parsePendingRooms(null)).toEqual([]);
    expect(parsePendingRooms('{not json')).toEqual([]);
    expect(parsePendingRooms('{"roomId":"room-1"}')).toEqual([]);
    expect(
      parsePendingRooms(JSON.stringify([{ roomId: 'room-1', createdAt: T0 }, { roomId: '', createdAt: 1 }, 7])),
    ).toEqual([{ roomId: 'room-1', createdAt: T0 }]);
  });

  test('a full ledger keeps every room it already owes and refuses the newcomer', () => {
    let records: CouncilPendingRoom[] = [];
    for (let index = 0; index < COUNCIL_PENDING_ROOM_CAP; index += 1) {
      const admission = rememberPendingRoom(records, `room-${index}`, T0 + index);
      expect(admission.refused).toBeUndefined();
      records = admission.records;
    }
    expect(records).toHaveLength(COUNCIL_PENDING_ROOM_CAP);
    expect(records[COUNCIL_PENDING_ROOM_CAP - 1]).toEqual({
      roomId: `room-${COUNCIL_PENDING_ROOM_CAP - 1}`,
      createdAt: T0 + COUNCIL_PENDING_ROOM_CAP - 1,
    });

    // The newcomer does not fit. Nothing already owed may be evicted for it:
    // the oldest records are the leftovers the sweep exists to delete.
    const refused = rememberPendingRoom(records, 'room-new', T0 + 99);
    expect(refused.refused).toEqual({ roomId: 'room-new', createdAt: T0 + 99 });
    expect(refused.records).toEqual(records);

    // Re-noting a room already owed refreshes its record in place, so it is
    // never refused and never duplicated, even at the bound.
    const refreshed = rememberPendingRoom(records, 'room-0', T0 + 200);
    expect(refreshed.refused).toBeUndefined();
    expect(refreshed.records).toHaveLength(COUNCIL_PENDING_ROOM_CAP);
    expect(refreshed.records.filter((record) => record.roomId === 'room-0')).toEqual([
      { roomId: 'room-0', createdAt: T0 + 200 },
    ]);

    // Forgetting one settles a real obligation and frees its slot.
    const freed = forgetPendingRooms(refreshed.records, ['room-1']);
    expect(freed).toHaveLength(COUNCIL_PENDING_ROOM_CAP - 1);
    expect(freed).not.toContainEqual(expect.objectContaining({ roomId: 'room-1' }));
    expect(rememberPendingRoom(freed, 'room-new', T0 + 300).refused).toBeUndefined();
    expect(stalePendingRooms(records, T0)).toEqual([]);
  });

  test('a legacy ledger past the bound is read as it stands, never trimmed', () => {
    // A build that stored more than the cap (or a hand-edited key) still owes
    // those rooms; an admission must not "normalise" the list by dropping some.
    const legacy = Array.from({ length: COUNCIL_PENDING_ROOM_CAP + 4 }, (_, index) => ({
      roomId: `old-${index}`,
      createdAt: T0 + index,
    }));
    const admission = rememberPendingRoom(legacy, 'room-new', T0 + 99);
    expect(admission.refused).toEqual({ roomId: 'room-new', createdAt: T0 + 99 });
    expect(admission.records).toEqual(legacy);
    expect(admission.records).toHaveLength(COUNCIL_PENDING_ROOM_CAP + 4);
  });

  test('a newcomer that does not fit is said out loud and no owed room is lost', async () => {
    const { store, rows } = fakeLedger();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let index = 0; index < COUNCIL_PENDING_ROOM_CAP; index += 1) {
        await notePendingRoom(store, `room-${index}`, T0 + index);
      }
      const owed = stored(rows);
      expect(owed).toHaveLength(COUNCIL_PENDING_ROOM_CAP);
      expect(warn).not.toHaveBeenCalled();

      await expect(notePendingRoom(store, 'room-new', T0 + 99)).resolves.toEqual({
        recorded: false,
        reason: 'full',
      });

      // Every obligation that was already recorded is still there, unchanged.
      expect(stored(rows)).toEqual(owed);
      // The refusal is reported rather than silently swallowed.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`[council] ${councilLedgerFullWarning('room-new')}`);
      expect(councilLedgerFullWarning('room-new')).toContain(String(COUNCIL_PENDING_ROOM_CAP));
    } finally {
      warn.mockRestore();
    }
  });

  test('a sweep that settles what is owed frees the ledger for new rooms again', async () => {
    const { store, rows } = fakeLedger();
    const deleteRoom = jest.fn(async () => ({ ok: true }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let index = 0; index < COUNCIL_PENDING_ROOM_CAP; index += 1) {
        await notePendingRoom(store, `room-${index}`, T0);
      }
      await notePendingRoom(store, 'room-refused', T0);
      expect(stored(rows)).toHaveLength(COUNCIL_PENDING_ROOM_CAP);

      // The next connected mount can still delete every room it kept.
      await sweepPendingRooms(store, deleteRoom, T0 + COUNCIL_ROOM_LEAK_MS);
      expect(deleteRoom).toHaveBeenCalledTimes(COUNCIL_PENDING_ROOM_CAP);
      expect(rows.has(COUNCIL_PENDING_ROOMS_KEY)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);

      await notePendingRoom(store, 'room-next', T0 + COUNCIL_ROOM_LEAK_MS);
      expect(stored(rows)).toEqual([{ roomId: 'room-next', createdAt: T0 + COUNCIL_ROOM_LEAK_MS }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
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

// ─── The screen: no durable admission, no send ─────────────────────────────
// These mount the real Council screen with a fake gateway. The ledger refusals
// are driven through the same key-value store the screen uses, so the
// assertions are about what the operator sees and whether a send happened, not
// about a helper's return value in isolation.

const SCOUT: PublicBot = { id: 'scout', displayName: 'Scout', routable: true };
const NIGHT: PublicBot = { id: 'night', displayName: 'Night', routable: true };

type MountedRound = {
  replies: { botId: string; text: string }[];
  errors?: { botId: string; error: string }[];
};

let mountedState: {
  status: string;
  hasGroupRooms: boolean;
  listBots: jest.Mock<Promise<PublicBot[]>, []>;
  openBot: jest.Mock<Promise<boolean>, [string]>;
  requestSurface: jest.Mock;
  botGroups: { create: jest.Mock; send: jest.Mock; deleteGroup: jest.Mock };
};
let mountedRenderer: ReactTestRenderer | undefined;

async function mountCouncil(): Promise<void> {
  await act(async () => {
    mountedRenderer = create(createElement(CouncilScreen));
  });
}

async function flushCouncil(ms = 0): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function mountedAll(type: ElementType): ReactTestInstance[] {
  return mountedRenderer!.root.findAll((node) => node.type === type);
}

function mountedButton(label: string): ReactTestInstance {
  return mountedAll('Button' as ElementType).find((node) => node.props.label === label) as ReactTestInstance;
}

async function pressMounted(label: string): Promise<void> {
  await act(async () => {
    mountedButton(label).props.onPress();
  });
}

async function selectMounted(label: string): Promise<void> {
  const chip = mountedAll('Chip' as ElementType).find((node) => node.props.label === label) as ReactTestInstance;
  await act(async () => {
    chip.props.onPress();
  });
}

async function typeMountedPrompt(text: string): Promise<void> {
  const field = mountedAll('TextField' as ElementType)[0];
  await act(async () => {
    field.props.onChangeText(text);
  });
}

function mountedErrorCauses(): string[] {
  return mountedAll('ErrorCard' as ElementType).map((node) => String(node.props.cause));
}

function mountedLedger(): CouncilPendingRoom[] {
  return parsePendingRooms(mockStore.get(COUNCIL_PENDING_ROOMS_KEY) ?? null);
}

/** A connected screen with two Bots picked and a prompt ready to send. */
async function readyCouncil(): Promise<void> {
  await mountCouncil();
  await flushCouncil();
  await selectMounted('Scout');
  await selectMounted('Night');
  await typeMountedPrompt('Compare notes.');
}

describe('the council screen never sends without a durable room record', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStore = new Map<string, string>();
    mountedState = {
      status: 'connected',
      hasGroupRooms: true,
      listBots: jest.fn().mockResolvedValue([SCOUT, NIGHT]),
      openBot: jest.fn().mockResolvedValue(true),
      requestSurface: jest.fn(),
      botGroups: {
        create: jest.fn().mockResolvedValue({ id: 'room-1', name: 'Council', memberIds: ['scout', 'night'] }),
        send: jest.fn().mockResolvedValue({ replies: [] } as MountedRound),
        deleteGroup: jest.fn().mockResolvedValue({ ok: true }),
      },
    };
    jest.mocked(useGateway).mockImplementation(
      () => mountedState as unknown as ReturnType<typeof useGateway>,
    );
  });

  afterEach(async () => {
    if (mountedRenderer) await act(async () => { mountedRenderer!.unmount(); });
    mountedRenderer = undefined;
    jest.useRealTimers();
  });

  test('a room created after the round times out is deleted without sending', async () => {
    await readyCouncil();
    let resolveRoom!: (value: { id: string; name: string; memberIds: string[] }) => void;
    mountedState.botGroups.create.mockReturnValueOnce(new Promise((resolve) => { resolveRoom = resolve; }));
    await pressMounted('Compare');
    await flushCouncil(COUNCIL_ROUND_TIMEOUT_MS);
    await act(async () => {
      resolveRoom({ id: 'late-room', name: 'Council', memberIds: ['scout', 'night'] });
    });
    await flushCouncil();
    expect(mountedState.botGroups.send).not.toHaveBeenCalled();
    expect(mountedState.botGroups.deleteGroup).toHaveBeenCalledWith('late-room');
  });

  test('a full ledger refuses visibly, deletes the new room, and sends nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await readyCouncil();
      const owed = Array.from({ length: COUNCIL_PENDING_ROOM_CAP }, (_, index) => ({
        roomId: `owed-${index}`,
        createdAt: Date.now(),
      }));
      mockStore.set(COUNCIL_PENDING_ROOMS_KEY, JSON.stringify(owed));

      await pressMounted('Compare');
      await flushCouncil();

      // No unrecorded round ever reaches the Gate.
      expect(mountedState.botGroups.send).not.toHaveBeenCalled();
      // The room that could not be recorded is still deleted now.
      expect(mountedState.botGroups.deleteGroup).toHaveBeenCalledWith('room-1');
      // Every old obligation is still exactly as it was.
      expect(mountedLedger()).toEqual(owed);
      // The refusal is visible and says the round was not sent.
      expect(mountedErrorCauses()).toContain(councilLedgerRefusalCopy('full'));
      expect(mountedAll('CouncilCompareView' as ElementType)).toHaveLength(0);
      expect(mountedButton('Compare')).toBeTruthy();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('a refused ledger write refuses visibly, deletes the room, and keeps old records', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await readyCouncil();
      const owed = [{ roomId: 'owed-old', createdAt: Date.now() }];
      mockStore.set(COUNCIL_PENDING_ROOMS_KEY, JSON.stringify(owed));
      jest.mocked(keyValueStorage.setItem).mockRejectedValueOnce(new Error('disk full'));

      await pressMounted('Compare');
      await flushCouncil();

      expect(mountedState.botGroups.send).not.toHaveBeenCalled();
      expect(mountedState.botGroups.deleteGroup).toHaveBeenCalledWith('room-1');
      expect(mountedLedger()).toEqual(owed);
      expect(mountedErrorCauses()).toContain(councilLedgerRefusalCopy('unwritable'));
    } finally {
      warn.mockRestore();
    }
  });

  test('a refused ledger read refuses visibly, deletes the room, and keeps old records', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await readyCouncil();
      const owed = [{ roomId: 'owed-old', createdAt: Date.now() }];
      mockStore.set(COUNCIL_PENDING_ROOMS_KEY, JSON.stringify(owed));
      jest.mocked(keyValueStorage.getItem).mockRejectedValueOnce(new Error('keychain unavailable'));

      await pressMounted('Compare');
      await flushCouncil();

      expect(mountedState.botGroups.send).not.toHaveBeenCalled();
      expect(mountedState.botGroups.deleteGroup).toHaveBeenCalledWith('room-1');
      expect(mountedLedger()).toEqual(owed);
      expect(mountedErrorCauses()).toContain(councilLedgerRefusalCopy('unreadable'));
    } finally {
      warn.mockRestore();
    }
  });

  test('a malformed ledger is left untouched and the round is not sent', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await readyCouncil();
      const malformed = '{"roomId":"owed-old"}';
      mockStore.set(COUNCIL_PENDING_ROOMS_KEY, malformed);

      await pressMounted('Compare');
      await flushCouncil();

      expect(mountedState.botGroups.send).not.toHaveBeenCalled();
      expect(mountedState.botGroups.deleteGroup).toHaveBeenCalledWith('room-1');
      expect(mockStore.get(COUNCIL_PENDING_ROOMS_KEY)).toBe(malformed);
      expect(mountedErrorCauses()).toContain(councilLedgerRefusalCopy('unreadable'));
    } finally {
      warn.mockRestore();
    }
  });
});

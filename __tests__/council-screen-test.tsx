// ─── Council: one round at a time, and a roster that survives a blip ───────
// The screen's round used to be guarded by React state read inside its own
// async handler, kept the operator waiting on a bookkeeping delete after the
// answers were already drawn, had no Stop and no bound at all, and answered a
// failed roster re-read by wiping the chips. Each of those is a real operator
// harm, so each is asserted here through the screen the way it is used: press
// the button, not the handler.

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
}));
jest.mock('@/components/chat/council-compare-view', () => ({
  CouncilCompareView: 'CouncilCompareView',
}));
jest.mock('@/context/gateway-provider', () => ({ useGateway: jest.fn() }));
// A key-value store the mocked ledger module really reads and writes, so a
// record kept by one mutation is still there for the next one.
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
import {
  COUNCIL_NO_ANSWER_COPY,
  COUNCIL_OFFLINE_COPY,
  COUNCIL_PENDING_ROOMS_KEY,
  COUNCIL_ROUND_TIMEOUT_MS,
  COUNCIL_STOPPED_NOTE,
  COUNCIL_TIMEOUT_NOTE,
  parsePendingRooms,
  type CouncilColumn,
  type CouncilPendingRoom,
} from '@/lib/gateway/council';

const BUTTON = 'Button' as ElementType;
const CHIP = 'Chip' as ElementType;
const TEXT = 'Text' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
const SKELETON = 'Skeleton' as ElementType;
const EMPTY_STATE = 'EmptyState' as ElementType;
const COMPARE_VIEW = 'CouncilCompareView' as ElementType;

const scout: PublicBot = { id: 'scout', displayName: 'Scout', routable: true };
const night: PublicBot = { id: 'night', displayName: 'Night', routable: true };
const ada: PublicBot = { id: 'ada', displayName: 'ada', routable: true };

type Round = { replies: { botId: string; text: string }[]; errors?: { botId: string; error: string }[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function answered(text: string): Round {
  return {
    replies: [
      { botId: 'scout', text: `${text} (Scout)` },
      { botId: 'night', text: `${text} (Night)` },
      { botId: 'ada', text: `${text} (ada)` },
    ],
  };
}

let state: {
  status: string;
  hasGroupRooms: boolean;
  listBots: jest.Mock<Promise<PublicBot[]>, []>;
  openBot: jest.Mock<Promise<boolean>, [string]>;
  requestSurface: jest.Mock;
  botGroups: { create: jest.Mock; send: jest.Mock; deleteGroup: jest.Mock };
};

let renderer: ReactTestRenderer;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(CouncilScreen));
  });
}

async function render(): Promise<void> {
  await act(async () => {
    renderer.update(createElement(CouncilScreen));
  });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function find(type: ElementType): ReactTestInstance {
  return renderer.root.find((node) => node.type === type);
}

function findAll(type: ElementType): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.type === type);
}

function button(label: string): ReactTestInstance {
  return findAll(BUTTON).find((node) => node.props.label === label) as ReactTestInstance;
}

function labels(): string[] {
  return findAll(BUTTON).map((node) => String(node.props.label));
}

async function press(label: string): Promise<void> {
  await act(async () => {
    button(label).props.onPress();
  });
}

async function select(label: string): Promise<void> {
  const chip = findAll(CHIP).find((node) => node.props.label === label) as ReactTestInstance;
  await act(async () => {
    chip.props.onPress();
  });
}

async function typePrompt(text: string): Promise<void> {
  await act(async () => {
    find(TEXT_FIELD).props.onChangeText(text);
  });
}

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

function said(): string[] {
  return findAll(TEXT).flatMap((node) => stringsIn(node.props.children));
}

function chips(): { label: string; selected: boolean }[] {
  return findAll(CHIP).map((node) => ({ label: String(node.props.label), selected: node.props.selected }));
}

function columns(): CouncilColumn[] {
  const views = findAll(COMPARE_VIEW);
  return (views[views.length - 1]?.props.columns ?? []) as CouncilColumn[];
}

function ledger(): CouncilPendingRoom[] {
  return parsePendingRooms(mockStore.get(COUNCIL_PENDING_ROOMS_KEY) ?? null);
}

/** A connected screen with two Bots picked and a prompt ready to send. */
async function readyToCompare(): Promise<void> {
  await mount();
  await flush();
  await select('Scout');
  await select('Night');
  await typePrompt('Compare notes.');
}

describe('one comparison is one round', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStore = new Map<string, string>();
    state = {
      status: 'connected',
      hasGroupRooms: true,
      listBots: jest.fn().mockResolvedValue([scout, night, ada]),
      openBot: jest.fn().mockResolvedValue(true),
      requestSurface: jest.fn(),
      botGroups: {
        create: jest.fn().mockResolvedValue({ id: 'room-1', name: 'Council', memberIds: ['scout', 'night'] }),
        send: jest.fn().mockResolvedValue(answered('here')),
        deleteGroup: jest.fn().mockResolvedValue({ ok: true }),
      },
    };
    jest.mocked(useGateway).mockImplementation(() => state as unknown as ReturnType<typeof useGateway>);
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer.unmount(); });
    jest.useRealTimers();
  });

  test('a normal round creates one room, draws the columns, and deletes the room', async () => {
    await readyToCompare();
    await press('Compare');
    await flush();

    expect(state.botGroups.create).toHaveBeenCalledTimes(1);
    expect(state.botGroups.create.mock.calls[0][0].memberIds).toEqual(['scout', 'night']);
    expect(columns().map((column) => [column.botId, column.state])).toEqual([
      ['scout', 'answered'],
      ['night', 'answered'],
    ]);
    expect(columns()[0]).toMatchObject({ text: 'here (Scout)' });
    expect(state.botGroups.deleteGroup).toHaveBeenCalledWith('room-1');
    expect(labels()).toContain('Compare');
    expect(labels()).not.toContain('Stop');
    expect(said()).not.toContain(COUNCIL_TIMEOUT_NOTE);
    // The room is a label, never the operator's prompt.
    expect(String(state.botGroups.create.mock.calls[0][0].name)).not.toContain('Compare notes');
    // The record is written when the room exists and dropped once it is gone.
    expect(state.botGroups.deleteGroup).toHaveBeenCalledWith('room-1');
    expect(ledger()).toEqual([]);
  });

  test('two taps inside one render make one room and one send', async () => {
    await readyToCompare();
    const send = deferred<Round>();
    state.botGroups.send.mockReturnValue(send.promise);

    // Both presses come from the SAME render's handler, which is exactly what
    // two taps inside one frame do on a phone.
    const tapCompare = button('Compare').props.onPress;
    await act(async () => {
      tapCompare();
      tapCompare();
    });
    await flush();

    expect(state.botGroups.create).toHaveBeenCalledTimes(1);
    expect(state.botGroups.send).toHaveBeenCalledTimes(1);
    await act(async () => { send.resolve(answered('once')); });
    await flush();
    expect(state.botGroups.deleteGroup).toHaveBeenCalledTimes(1);
  });

  test('the button returns to Compare without waiting for the room delete', async () => {
    await readyToCompare();
    // The Gate went away mid-round: the delete never comes back, which is what
    // used to hold the button on its asking state for the transport's 30s.
    state.botGroups.deleteGroup.mockReturnValue(new Promise<never>(() => undefined));
    await press('Compare');
    await flush();

    expect(columns()).toHaveLength(2);
    expect(labels()).toContain('Compare');
    expect(labels()).not.toContain('Stop');
    expect(button('Compare').props.disabled).toBe(false);
    // The answers are on screen and the screen is idle; the delete is still owed.
    expect(ledger()).toEqual([{ roomId: 'room-1', createdAt: expect.any(Number) }]);
  });

  test('a refused delete keeps its ledger record for the next sweep and never blocks', async () => {
    await readyToCompare();
    state.botGroups.deleteGroup.mockRejectedValue(new Error('Request timed out: DELETE /v1/bot-groups/room-1'));
    await press('Compare');
    await flush();

    expect(labels()).toContain('Compare');
    expect(ledger()).toEqual([{ roomId: 'room-1', createdAt: expect.any(Number) }]);
  });

  test('Stop unlocks the screen at once and the abandoned answer never paints', async () => {
    await readyToCompare();
    const send = deferred<Round>();
    state.botGroups.send.mockReturnValue(send.promise);
    await press('Compare');
    await flush();
    expect(labels()).toContain('Stop');

    await press('Stop');
    expect(labels()).toContain('Compare');
    expect(labels()).not.toContain('Stop');
    expect(said()).toContain(COUNCIL_STOPPED_NOTE);
    expect(columns()).toEqual([]);
    // Stop takes the room back while this process still knows its id.
    expect(state.botGroups.deleteGroup).toHaveBeenCalledWith('room-1');

    await act(async () => { send.resolve(answered('too late')); });
    await flush(COUNCIL_ROUND_TIMEOUT_MS);
    expect(columns()).toEqual([]);
    expect(said()).toContain(COUNCIL_STOPPED_NOTE);
  });

  test('a stopped round can be started again immediately', async () => {
    await readyToCompare();
    const stopped = deferred<Round>();
    state.botGroups.send.mockReturnValueOnce(stopped.promise).mockResolvedValue(answered('second'));
    await press('Compare');
    await flush();
    await press('Stop');
    await press('Compare');
    await flush();

    expect(state.botGroups.create).toHaveBeenCalledTimes(2);
    expect(columns().map((column) => column.state)).toEqual(['answered', 'answered']);
    expect(said()).not.toContain(COUNCIL_STOPPED_NOTE);
    await act(async () => { stopped.resolve(answered('too late')); });
    await flush();
    expect(columns()[0]).toMatchObject({ text: 'second (Scout)' });
  });

  test('the 120s bound unlocks a wedged Bot and says what is missing', async () => {
    await readyToCompare();
    const wedged = deferred<Round>();
    state.botGroups.send.mockReturnValue(wedged.promise);
    await press('Compare');
    await flush();
    expect(labels()).toContain('Stop');

    await flush(COUNCIL_ROUND_TIMEOUT_MS);
    expect(labels()).toContain('Compare');
    expect(labels()).not.toContain('Stop');
    expect(said()).toContain(COUNCIL_TIMEOUT_NOTE);
    expect(
      columns().map((column) => [column.botId, column.state, column.state === 'failed' && column.error]),
    ).toEqual([
      ['scout', 'failed', COUNCIL_NO_ANSWER_COPY],
      ['night', 'failed', COUNCIL_NO_ANSWER_COPY],
    ]);
    expect(state.botGroups.deleteGroup).toHaveBeenCalledWith('room-1');

    // The wedged round answers after the bound: it must not repaint anything.
    await act(async () => { wedged.resolve(answered('too late')); });
    await flush();
    expect(
      columns().map((column) => [column.botId, column.state]),
    ).toEqual([
      ['scout', 'failed'],
      ['night', 'failed'],
    ]);
    expect(said()).toContain(COUNCIL_TIMEOUT_NOTE);
  });
});

describe('the roster read is a state machine, not a wipe', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStore = new Map<string, string>();
    state = {
      status: 'connected',
      hasGroupRooms: true,
      listBots: jest.fn().mockResolvedValue([scout, night, ada]),
      openBot: jest.fn().mockResolvedValue(true),
      requestSurface: jest.fn(),
      botGroups: {
        create: jest.fn().mockResolvedValue({ id: 'room-1', name: 'Council', memberIds: ['scout', 'night'] }),
        send: jest.fn().mockResolvedValue(answered('here')),
        deleteGroup: jest.fn().mockResolvedValue({ ok: true }),
      },
    };
    jest.mocked(useGateway).mockImplementation(() => state as unknown as ReturnType<typeof useGateway>);
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer.unmount(); });
    jest.useRealTimers();
  });

  test('a screen opened while disconnected says so instead of showing skeletons', async () => {
    state.status = 'disconnected';
    await mount();
    await flush();

    expect(findAll(SKELETON)).toHaveLength(0);
    const offline = findAll(EMPTY_STATE);
    expect(offline).toHaveLength(1);
    expect(offline[0].props.description).toBe(COUNCIL_OFFLINE_COPY);
    expect(offline[0].props.title).toMatch(/not connected/i);
    expect(findAll('ErrorCard' as ElementType)).toHaveLength(0);
    expect(state.listBots).not.toHaveBeenCalled();
  });

  test('a connection that drops mid-read stops claiming to load a list it never asked for', async () => {
    const read = deferred<PublicBot[]>();
    state.listBots.mockReturnValue(read.promise);
    await mount();
    await flush();
    expect(findAll(SKELETON).length).toBeGreaterThan(0);

    state.status = 'disconnected';
    await render();
    expect(findAll(SKELETON)).toHaveLength(0);
    expect(findAll(EMPTY_STATE)[0].props.description).toBe(COUNCIL_OFFLINE_COPY);

    // Reconnecting reads again, and the roster lands.
    state.listBots.mockResolvedValue([scout, night]);
    state.status = 'connected';
    await render();
    await flush();
    expect(chips()).toEqual([
      { label: 'Scout', selected: false },
      { label: 'Night', selected: false },
    ]);
    expect(state.listBots).toHaveBeenCalledTimes(2);
  });

  test('a failed re-read keeps the chips, the selection, and says the refresh failed', async () => {
    await mount();
    await flush();
    await select('Scout');
    await select('Night');

    state.status = 'disconnected';
    await render();
    state.listBots.mockRejectedValue(new Error('refused'));
    state.status = 'connected';
    await render();
    await flush();

    expect(chips()).toEqual([
      { label: 'Scout', selected: true },
      { label: 'Night', selected: true },
      { label: 'ada', selected: false },
    ]);
    expect(said()).toContain("Couldn't refresh the Bot list");
    expect(labels()).toContain('Retry');
    expect(findAll(EMPTY_STATE)).toHaveLength(0);

    // The retry reads again and a good roster replaces the stale one.
    state.listBots.mockResolvedValue([scout]);
    await press('Retry');
    await flush();
    expect(chips()).toEqual([{ label: 'Scout', selected: true }]);
  });

  test('a read that lands after a newer one cannot repaint over it', async () => {
    await mount();
    await flush();
    await select('Scout');
    state.listBots.mockRejectedValueOnce(new Error('refused'));
    state.status = 'disconnected';
    await render();
    state.status = 'connected';
    await render();
    await flush();
    expect(said()).toContain("Couldn't refresh the Bot list");

    const slow = deferred<PublicBot[]>();
    state.listBots.mockReturnValue(slow.promise);
    await press('Retry');
    state.listBots.mockResolvedValue([ada]);
    state.status = 'disconnected';
    await render();
    state.status = 'connected';
    await render();
    await flush();
    expect(chips().map((chip) => chip.label)).toEqual(['ada']);

    await act(async () => { slow.resolve([scout, night, ada]); });
    await flush();
    expect(chips().map((chip) => chip.label)).toEqual(['ada']);
  });

  test('a first read with no roster behind it is still an honest failure', async () => {
    state.listBots.mockRejectedValue(new Error('refused'));
    await mount();
    await flush();

    expect(findAll(EMPTY_STATE)).toHaveLength(0);
    const failures = findAll('ErrorCard' as ElementType);
    expect(failures).toHaveLength(1);
    expect(failures[0].props.cause).toBe('refused');
  });
});

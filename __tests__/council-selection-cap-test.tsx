// ─── Council: a picked chip is a Bot the round actually asks ───────────────
// The screen capped what it asked (`councilTargets(..., 3)`) but not what it
// recorded as picked, so a fourth chip lit up, the counter already read 3/3,
// and that Bot's answer never came. These tests drive the mounted screen the
// way it is used — press the chips, press Compare — and read the room the
// screen created: the highlight, the count and the asked Bots must agree.

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

// A key-value store the screen's ledger module really reads and writes, so a
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
import type { CouncilColumn } from '@/lib/gateway/council';

const CHIP = 'Chip' as ElementType;
const BUTTON = 'Button' as ElementType;
const TEXT = 'Text' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
const COMPARE_VIEW = 'CouncilCompareView' as ElementType;

const scout: PublicBot = { id: 'scout', displayName: 'Scout', routable: true };
const night: PublicBot = { id: 'night', displayName: 'Night', routable: true };
const ada: PublicBot = { id: 'ada', displayName: 'ada', routable: true };
const herald: PublicBot = { id: 'herald', displayName: 'Herald', routable: true };

const ROSTER = [scout, night, ada, herald];

type Round = { replies: { botId: string; text: string }[]; errors?: { botId: string; error: string }[] };

function answered(text: string): Round {
  return {
    replies: ROSTER.map((bot) => ({ botId: bot.id, text: `${text} (${bot.displayName})` })),
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

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function findAll(type: ElementType): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.type === type);
}

function chips(): { label: string; selected: boolean; disabled: boolean }[] {
  return findAll(CHIP).map((node) => ({
    label: String(node.props.label),
    selected: Boolean(node.props.selected),
    disabled: Boolean(node.props.disabled),
  }));
}

function chip(label: string): ReactTestInstance {
  return findAll(CHIP).find((node) => node.props.label === label) as ReactTestInstance;
}

/** The press handler the chip currently renders — what a tap would call. */
function chipPress(label: string): () => void {
  return chip(label).props.onPress as () => void;
}

function picked(): string[] {
  return chips()
    .filter((entry) => entry.selected)
    .map((entry) => entry.label);
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

function columns(): CouncilColumn[] {
  const views = findAll(COMPARE_VIEW);
  return (views[views.length - 1]?.props.columns ?? []) as CouncilColumn[];
}

async function select(label: string): Promise<void> {
  await act(async () => {
    chipPress(label)();
  });
}

async function typePrompt(text: string): Promise<void> {
  await act(async () => {
    (findAll(TEXT_FIELD)[0] as ReactTestInstance).props.onChangeText(text);
  });
}

async function pressCompare(): Promise<void> {
  const compare = findAll(BUTTON).find((node) => node.props.label === 'Compare') as ReactTestInstance;
  await act(async () => {
    compare.props.onPress();
  });
}

/** A connected screen with a four-Bot roster and its read already landed. */
async function mountedRoster(): Promise<void> {
  await mount();
  await flush();
}

describe('the council asks exactly the Bots its chips show as picked', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStore = new Map<string, string>();
    state = {
      status: 'connected',
      hasGroupRooms: true,
      listBots: jest.fn().mockResolvedValue(ROSTER),
      openBot: jest.fn().mockResolvedValue(true),
      requestSurface: jest.fn(),
      botGroups: {
        create: jest.fn().mockResolvedValue({ id: 'room-1', name: 'Council', memberIds: [] }),
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

  test('a fourth pick is unavailable, so the counter and the asked Bots stay at three', async () => {
    await mountedRoster();
    await select('Scout');
    await select('Night');
    await select('ada');

    expect(chips()).toEqual([
      { label: 'Scout', selected: true, disabled: false },
      { label: 'Night', selected: true, disabled: false },
      { label: 'ada', selected: true, disabled: false },
      { label: 'Herald', selected: false, disabled: true },
    ]);
    expect(said()).toContain('Bots to compare (3/3)');

    // Even the handler behind the now-unavailable chip refuses the pick: a
    // press that races the cap must not light a Bot no column will ever show.
    await select('Herald');
    expect(picked()).toEqual(['Scout', 'Night', 'ada']);
    expect(chips().find((entry) => entry.label === 'Herald')).toMatchObject({ selected: false, disabled: true });
    expect(said()).toContain('Bots to compare (3/3)');

    await typePrompt('Compare notes.');
    await pressCompare();
    await flush();

    expect(state.botGroups.create).toHaveBeenCalledTimes(1);
    expect(state.botGroups.create.mock.calls[0][0].memberIds).toEqual(['scout', 'night', 'ada']);
    expect(columns().map((column) => column.botId)).toEqual(['scout', 'night', 'ada']);
  });

  test('four picks inside one tick still ask only three, in roster order', async () => {
    await mountedRoster();
    // Every handler comes from the SAME render, which is what several taps
    // inside one frame are: none of them sees the others' selection yet.
    const press = ROSTER.map((bot) => chipPress(bot.displayName));

    await act(async () => {
      for (const tap of press) tap();
    });

    expect(picked()).toEqual(['Scout', 'Night', 'ada']);
    expect(chips().find((entry) => entry.label === 'Herald')).toMatchObject({ selected: false, disabled: true });
    expect(said()).toContain('Bots to compare (3/3)');

    await typePrompt('Compare notes.');
    await pressCompare();
    await flush();

    expect(state.botGroups.create.mock.calls[0][0].memberIds).toEqual(['scout', 'night', 'ada']);
    expect(columns()).toHaveLength(3);
  });

  test('a picked chip stays operable at the cap, and deselecting it frees the slot', async () => {
    await mountedRoster();
    await select('Scout');
    await select('Night');
    await select('ada');

    // The cap dims only the Bots that cannot join; it never traps the picks.
    await select('ada');
    expect(picked()).toEqual(['Scout', 'Night']);
    expect(said()).toContain('Bots to compare (2/3)');
    expect(chips().every((entry) => entry.disabled === false)).toBe(true);

    // The freed slot is the fourth Bot's to take, and Compare follows it.
    await select('Herald');
    expect(picked()).toEqual(['Scout', 'Night', 'Herald']);
    expect(said()).toContain('Bots to compare (3/3)');

    await typePrompt('Compare notes.');
    await pressCompare();
    await flush();

    expect(state.botGroups.create.mock.calls[0][0].memberIds).toEqual(['scout', 'night', 'herald']);
    expect(columns().map((column) => column.botId)).toEqual(['scout', 'night', 'herald']);
  });

  test('a deselect and a pick in one tick swap a Bot rather than dropping the pick', async () => {
    await mountedRoster();
    await select('Scout');
    await select('Night');
    await select('ada');

    // Both taps read the same render: the deselect must land before the cap
    // refuses the pick, or the operator loses the Bot they meant to swap in.
    const deselectNight = chipPress('Night');
    const pickHerald = chipPress('Herald');
    await act(async () => {
      deselectNight();
      pickHerald();
    });

    expect(picked()).toEqual(['Scout', 'ada', 'Herald']);
    expect(said()).toContain('Bots to compare (3/3)');

    await typePrompt('Compare notes.');
    await pressCompare();
    await flush();

    // Roster order decides the columns, not the order the chips were tapped.
    expect(state.botGroups.create.mock.calls[0][0].memberIds).toEqual(['scout', 'ada', 'herald']);
    expect(columns().map((column) => column.botId)).toEqual(['scout', 'ada', 'herald']);
  });
});

// ─── Council: a failed Bot keeps its slot ──────────────────────────────────
// PENDING.md carried "a failed Bot slot is shown, not silently dropped" as an
// unverified item. The screen now maps the Gate's per-Bot round errors and the
// 120 s bound into failed columns, and CouncilCompareView draws each of those
// as its own named card. This test pins that whole chain the way an operator
// uses it — press Compare and read the screen — so a regression that filters a
// failed column out (or collapses it into the summary / a screen-level error)
// fails here instead of only differing from a source string.
//
// The kit is mocked to plain host components, but the compare view under it is
// the real one: these assertions inspect the slots the operator actually gets.

jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));
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
jest.mock('@/context/gateway-provider', () => ({ useGateway: jest.fn() }));
// tokens.ts only needs Easing for its motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));
// A real key-value map so the transient-room ledger the screen writes behaves
// as it does on device (read-back included) rather than as a bare stub.
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

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import CouncilScreen from '@/app/council';
import { useGateway } from '@/context/gateway-provider';
import type { PublicBot } from '@/lib/gateway/bots';
import {
  COUNCIL_NO_ANSWER_COPY,
  COUNCIL_ROUND_TIMEOUT_MS,
  COUNCIL_TIMEOUT_NOTE,
} from '@/lib/gateway/council';

const BUTTON = 'Button' as ElementType;
const CHIP = 'Chip' as ElementType;
const TEXT = 'Text' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;
const PRESSABLE = 'PressableScale' as ElementType;

const scout: PublicBot = { id: 'scout', displayName: 'Scout', routable: true };
const night: PublicBot = { id: 'night', displayName: 'Night', routable: true };
const ada: PublicBot = { id: 'ada', displayName: 'ada', routable: true };

type Round = {
  replies: { botId: string; text: string }[];
  errors?: { botId: string; error: string }[];
};

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

function button(label: string): ReactTestInstance {
  return findAll(BUTTON).find((node) => node.props.label === label) as ReactTestInstance;
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
    findAll(TEXT_FIELD)[0].props.onChangeText(text);
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

function errorCards(): ReactTestInstance[] {
  return findAll(ERROR_CARD);
}

/**
 * The Bot slots the compare view drew, in draw order. A failed or silent slot
 * is a plain View (no press target), an answered one a PressableScale; both
 * carry the "<Bot>, <state>" label this filters on.
 */
function slotsDrawn(): string[] {
  return renderer.root
    .findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props.accessibilityLabel === 'string' &&
        /, (answered|failed|had nothing to add)$/.test(node.props.accessibilityLabel),
    )
    .map((node) => String(node.props.accessibilityLabel));
}

/** A connected screen with the named Bots picked and a prompt ready to send. */
async function readyToCompare(labels: string[] = ['Scout', 'Night', 'ada']): Promise<void> {
  await mount();
  await flush();
  for (const label of labels) await select(label);
  await typePrompt('Compare notes.');
}

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
      create: jest.fn().mockResolvedValue({ id: 'room-1', name: 'Council', memberIds: ['scout', 'night', 'ada'] }),
      send: jest.fn().mockResolvedValue({ replies: [] }),
      deleteGroup: jest.fn().mockResolvedValue({ ok: true }),
    },
  };
  jest.mocked(useGateway).mockImplementation(() => state as unknown as ReturnType<typeof useGateway>);
});

afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  jest.useRealTimers();
});

test("a Bot's round error keeps its own slot, in roster order, and names the error", async () => {
  const round: Round = {
    replies: [
      { botId: 'scout', text: 'Scout read the notes.' },
      { botId: 'ada', text: 'ada read the notes.' },
    ],
    errors: [{ botId: 'night', error: 'Night is out of credits' }],
  };
  state.botGroups.send.mockResolvedValue(round);

  await readyToCompare();
  await press('Compare');
  await flush();

  // All three slots are drawn, the failed one between the two answers, so the
  // failure never collapses into the summary.
  expect(slotsDrawn()).toEqual(['Scout, answered', 'Night, failed', 'ada, answered']);
  expect(said()).toContain('2 of 3 answered.');

  // The failed slot carries the Bot's own error, not a screen-level one.
  const failures = errorCards();
  expect(failures).toHaveLength(1);
  expect(failures[0].props.cause).toBe('Night is out of credits');
  expect(failures[0].props.affected).toBe("Night's answer");

  // A failed slot has nowhere to open: it is not a press target.
  const pressables = findAll(PRESSABLE).filter(
    (node) => typeof node.props.accessibilityLabel === 'string',
  );
  expect(pressables.map((node) => node.props.accessibilityLabel)).toEqual([
    'Scout, answered',
    'ada, answered',
  ]);
});

test('an all-failed round draws every slot and every error', async () => {
  state.botGroups.send.mockResolvedValue({
    replies: [],
    errors: [
      { botId: 'scout', error: 'Scout did not answer' },
      { botId: 'night', error: 'Night is out of credits' },
      { botId: 'ada', error: 'ada is unreachable' },
    ],
  });

  await readyToCompare();
  await press('Compare');
  await flush();

  expect(slotsDrawn()).toEqual(['Scout, failed', 'Night, failed', 'ada, failed']);
  expect(errorCards().map((node) => node.props.cause)).toEqual([
    'Scout did not answer',
    'Night is out of credits',
    'ada is unreachable',
  ]);
  expect(said()).toContain('0 of 3 answered.');
});

test('the 120s bound leaves a named failed slot for each Bot that never answered', async () => {
  // The round itself never settles: the Gate has fanned out but one Bot is
  // wedged. The screen's own bound must still leave a slot per Bot.
  state.botGroups.send.mockReturnValue(new Promise<Round>(() => undefined));

  await readyToCompare(['Scout', 'Night']);
  await press('Compare');
  await flush();
  expect(slotsDrawn()).toEqual([]);

  await flush(COUNCIL_ROUND_TIMEOUT_MS);

  expect(slotsDrawn()).toEqual(['Scout, failed', 'Night, failed']);
  expect(errorCards().map((node) => node.props.cause)).toEqual([
    COUNCIL_NO_ANSWER_COPY,
    COUNCIL_NO_ANSWER_COPY,
  ]);
  expect(said()).toContain('0 of 2 answered.');
  expect(said()).toContain(COUNCIL_TIMEOUT_NOTE);
});

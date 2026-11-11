// ─── Council: a gateway switch is a new owner for the roster ───────────────
// The roster read was keyed to the connection status and a stable `listBots`,
// so a connected switch to another gateway neither re-read nor dropped what was
// there: the previous gateway's Bots stayed on the chips, its Bots stayed
// picked, and a round could be created with members the new gateway may never
// have heard of. Each case drives the switch through the mounted screen the way
// it is used — pick chips on A, switch, look at B — and reads the chips the
// operator would see.

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

const BUTTON = 'Button' as ElementType;
const CHIP = 'Chip' as ElementType;
const TEXT = 'Text' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
const SKELETON = 'Skeleton' as ElementType;

const scout: PublicBot = { id: 'scout', displayName: 'Scout', routable: true };
const night: PublicBot = { id: 'night', displayName: 'Night', routable: true };
const ada: PublicBot = { id: 'ada', displayName: 'ada', routable: true };
const bertha: PublicBot = { id: 'bertha', displayName: 'Bertha', routable: true };

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
    ],
  };
}

let state: {
  activeGateway: { id: string } | null;
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

function chips(): { label: string; selected: boolean }[] {
  return findAll(CHIP).map((node) => ({ label: String(node.props.label), selected: node.props.selected }));
}

function picked(): string[] {
  return chips().filter((chip) => chip.selected).map((chip) => chip.label);
}

function skeletons(): number {
  return findAll(SKELETON).length;
}

/** A connected screen on gateway A whose roster of Scout and Night has landed. */
async function onGatewayA(): Promise<void> {
  await mount();
  await flush();
  expect(chips()).toEqual([
    { label: 'Scout', selected: false },
    { label: 'Night', selected: false },
  ]);
}

describe('a gateway switch starts the council from the new gateway', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStore = new Map<string, string>();
    state = {
      activeGateway: { id: 'gateway-a' },
      status: 'connected',
      hasGroupRooms: true,
      listBots: jest.fn().mockResolvedValue([scout, night]),
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

  test("the previous gateway's Bots and picks are gone after a switch", async () => {
    await onGatewayA();
    await select('Scout');
    await select('Night');
    expect(picked()).toEqual(['Scout', 'Night']);

    state.listBots.mockResolvedValue([bertha]);
    state.activeGateway = { id: 'gateway-b' };
    await render();
    await flush();

    expect(chips()).toEqual([{ label: 'Bertha', selected: false }]);
    expect(picked()).toEqual([]);
    expect(said()).toContain('Bots to compare (0/3)');
    // The old picks cannot become a room on the gateway that never had them,
    // even when the handler is pressed from the render that still shows them.
    await typePrompt('Compare notes.');
    await press('Compare');
    await flush();
    expect(state.botGroups.create).not.toHaveBeenCalled();
    expect(labels()).toContain('Compare');
  });

  test("a roster answer the previous gateway still owed never appears on the new one", async () => {
    await onGatewayA();

    // A re-read on A is in flight when the operator switches: this is the
    // answer that lands after B is already the active gateway.
    const lateA = deferred<PublicBot[]>();
    state.listBots.mockReturnValue(lateA.promise);
    state.status = 'disconnected';
    await render();
    state.status = 'connected';
    await render();
    await flush();
    expect(chips().map((chip) => chip.label)).toEqual(['Scout', 'Night']);

    state.listBots.mockResolvedValue([bertha]);
    state.activeGateway = { id: 'gateway-b' };
    await render();
    await flush();
    expect(chips().map((chip) => chip.label)).toEqual(['Bertha']);

    await act(async () => { lateA.resolve([scout, night, ada]); });
    await flush();
    expect(chips().map((chip) => chip.label)).toEqual(['Bertha']);
    expect(picked()).toEqual([]);
  });

  test("the new gateway's roster shows once it resolves, with nothing left picked", async () => {
    await onGatewayA();
    await select('Scout');

    // B's read is slow: the slot must show it is loading B — never A's chips,
    // and never A's pick as this gateway's selection.
    const readB = deferred<PublicBot[]>();
    state.listBots.mockReturnValue(readB.promise);
    state.activeGateway = { id: 'gateway-b' };
    await render();

    expect(chips()).toEqual([]);
    expect(skeletons()).toBeGreaterThan(0);
    expect(said()).toContain('Bots to compare (0/3)');
    expect(button('Compare').props.disabled).toBe(true);

    await flush();
    expect(chips()).toEqual([]);
    expect(skeletons()).toBeGreaterThan(0);

    await act(async () => { readB.resolve([bertha]); });
    await flush();
    expect(chips()).toEqual([{ label: 'Bertha', selected: false }]);
    expect(picked()).toEqual([]);
  });
});

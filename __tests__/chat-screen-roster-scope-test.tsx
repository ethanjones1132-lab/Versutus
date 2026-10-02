// ─── The roster read is the screen's own inventory, and it is keyed ─────────
// Four verified defects in one place, all of them about WHO a roster answer
// belongs to and WHAT a read that never settled leaves behind:
//   ROSTER-1  a read cancelled by a status flip kept the 20s throttle, so the
//             reconnect inside that window read nothing and the roster spun
//             forever — no rows, no error, no refresh control.
//   V-1       refreshRoster captured the gateway before its awaits and folded
//             the answer with it, so a switch mid-refresh painted the old
//             gateway's Bots under the new one.
//   BOT-3     a create whose follow-up roster read failed wrote its error into
//             the sheet it had just closed, so the new Agent was invisible.
//   OPEN-7    a Bot open that RESOLVED false (superseded, capability refused)
//             left the screen on that Bot's thread with nothing named.
//
// The screen is rendered for real: the roster rows, the sheets and the room
// view are the components chat-screen itself draws, and the provider seam is
// the only thing standing in. Props are read off the rendered components
// (`findByType(ChatRoster).props`) rather than guessed at from the tree, and
// the callbacks under test are invoked the way a tap invokes them.

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatRoster } from '@/components/chat/chat-roster';
import { GroupRoomView } from '@/components/chat/group-room-view';
import { NewAgentSheet } from '@/components/chat/new-agent-sheet';
import { ChatScreen } from '@/components/chat/chat-screen';
import type { PublicBot } from '@/lib/gateway/bots';
import type { BotGroupRoom } from '@/lib/gateway/groups';

// chat-screen pulls in the whole visual tree. None of it is what these tests
// are about, so the native seams are mocked and every stand-in is built INSIDE
// its factory (chat-screen is imported at the top of this file).
jest.mock('react-native-reanimated', () => {
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_target, key) => (key === 'then' ? undefined : proxy),
      apply: () => proxy,
    });
    return proxy;
  };
  const easing = new Proxy({ bezier: () => (value: number) => value }, {
    get: (target, key) =>
      key in target
        ? (target as unknown as Record<string | symbol, unknown>)[key]
        : () => (value: number) => value,
  }) as Record<string, unknown>;
  const sharedBox = (value: unknown) => {
    const box = {
      value,
      get: () => box.value,
      set: (next: unknown) => {
        box.value = next;
      },
      modify: (modify: (current: unknown) => unknown) => {
        box.value = modify(box.value);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
    };
    return box;
  };
  const known: Record<string, unknown> = {
    default: { View: 'Animated.View', createAnimatedComponent: (component: unknown) => component },
    Easing: easing,
    Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
    useSharedValue: (value: unknown) => sharedBox(value),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (factory: () => unknown) => sharedBox(factory()),
    useReducedMotion: () => false,
    View: 'Animated.View',
    Text: 'Animated.Text',
    ScrollView: 'Animated.ScrollView',
    createAnimatedComponent: (component: unknown) => component,
    runOnJS: (fn: unknown) => fn,
  };
  // Everything else the avatar/figure animations reach for is a chainable
  // no-op: this screen's behaviour under test is reads and surfaces, not the
  // Bot's blink.
  return new Proxy(known, { get: (target, key) => (key in target ? target[key as string] : chain()) });
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ dispatch: jest.fn(), setOptions: jest.fn() }),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: 'Canvas',
  Fill: 'Fill',
  Shader: 'Shader',
  Skia: {
    RuntimeEffect: { Make: jest.fn(() => ({ uniforms: {} })) },
    Paint: jest.fn(),
    Color: jest.fn(),
    Point: jest.fn(),
  },
  RuntimeEffect: { Make: jest.fn(() => ({ uniforms: {} })) },
  Paint: jest.fn(),
  Group: 'Group',
  Circle: 'Circle',
  Path: 'Path',
  LinearGradient: 'LinearGradient',
  SweepGradient: 'SweepGradient',
  useClock: () => 0,
  usePathValue: () => ({ current: null }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: 'SafeAreaView',
  SafeAreaProvider: 'SafeAreaProvider',
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  withSafeAreaInsets: (component: unknown) => component,
}));
jest.mock('@/lib/haptics', () => ({
  haptics: { selection: () => Promise.resolve(), success: () => Promise.resolve() },
}));
// The design primitives are host elements here: every runtime export of
// `@/components/ui` is a component, and the roster rules under test are in
// chat-screen and in the components it draws. The one that cannot load under
// jest is the iOS TextField (`@expo/ui`'s native state), which the roster's
// own search field reaches as soon as a Bot row exists.
jest.mock(
  '@/components/ui',
  () =>
    new Proxy(
      {},
      {
        get: (_target, key) => (typeof key === 'string' && key !== '__esModule' ? key : undefined),
      },
    ),
);

/** This device's own store, which the remembered roster is read from. */
let mockCache: Map<string, { value: unknown; savedAt: number }>;
/** Parks every `readCached` behind a promise the test releases. */
let mockCacheGate: Promise<void> | null = null;
jest.mock('@/lib/cache/swr-store', () => ({
  readCached: jest.fn(async (namespace: string, gatewayId: string, key: string) => {
    const entry = mockCache.get(`${namespace}:${gatewayId}:${key}`) ?? null;
    if (mockCacheGate) await mockCacheGate;
    return entry;
  }),
  writeCached: jest.fn(async (namespace: string, gatewayId: string, key: string, value: unknown) => {
    mockCache.set(`${namespace}:${gatewayId}:${key}`, { value, savedAt: Date.now() });
  }),
}));

type GatewayEnv = {
  gateway: Record<string, unknown>;
  listBots: jest.Mock;
  openBot: jest.Mock;
  createBot: jest.Mock;
  listGroups: jest.Mock;
  botGroups: Record<string, jest.Mock>;
};

const mockEnv: GatewayEnv = {
  gateway: {},
  listBots: jest.fn(),
  openBot: jest.fn(),
  createBot: jest.fn(),
  listGroups: jest.fn(),
  botGroups: {},
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockEnv.gateway,
  useChatSurface: () => ({ messages: [], isSending: false, isCommandRunning: false }),
}));
jest.mock('@/context/handsfree-voice-provider', () => ({
  useHandsfreeVoice: () => ({ active: false, canStart: false, end: jest.fn() }),
}));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#fff',
    accentWarmMuted: '#fff',
    border: '#fff',
    background: '#fff',
    backgroundElevated: '#fff',
    backgroundRaised: '#fff',
    statusDisconnected: '#fff',
    stageGlass: '#fff',
    specular: '#fff',
    accentMuted: '#fff',
  }),
}));

const GATEWAY_A = { id: 'gw-a', name: 'Studio', model: 'm', modelLocks: [] };
const GATEWAY_B = { id: 'gw-b', name: 'Attic', model: 'm', modelLocks: [] };

function bot(id: string): PublicBot {
  return { id, displayName: id, routable: true };
}

function room(id: string): BotGroupRoom {
  return { id, name: id, memberIds: ['one', 'two'] };
}

/** The provider shape chat-screen reads. Built ONCE per test: the screen keys
 * several of its reads on `listBots`, so a fresh function identity on every
 * re-render would re-run those effects on a redraw that changed nothing. */
function gatewayEnv(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeGateway: GATEWAY_A,
    settings: {},
    status: 'connected',
    statusDetail: undefined,
    connectionPhase: 'idle',
    probeMessage: undefined,
    lastError: undefined,
    clearLastError: jest.fn(),
    deviceId: 'device-1',
    pairingDetails: undefined,
    sendChatInput: jest.fn(),
    activeHello: undefined,
    reloadHistory: jest.fn(),
    retryAutoConnect: jest.fn(),
    retryCommand: jest.fn(),
    cancelCommand: jest.fn(),
    pendingConfirmation: undefined,
    confirmPendingAction: jest.fn(),
    cancelPendingConfirmation: jest.fn(),
    modelPicker: { mode: 'default', visible: false, agentId: undefined },
    openModelPicker: jest.fn(),
    closeModelPicker: jest.fn(),
    stopStreaming: jest.fn(),
    selectModel: jest.fn(),
    clearModelLock: jest.fn(),
    modelCatalog: [],
    modelCatalogError: undefined,
    modelCatalogLoaded: false,
    sessionSelector: { visible: false, loading: false, error: undefined },
    openSessionSelector: jest.fn(),
    closeSessionSelector: jest.fn(),
    selectSession: jest.fn(),
    sessionList: [],
    sessionListError: undefined,
    sessionListLoaded: false,
    sessionListHasOlder: false,
    loadingOlderSessions: false,
    loadOlderSessions: jest.fn(),
    currentSessionId: undefined,
    pendingRunApproval: undefined,
    resolveRunApproval: jest.fn(),
    recentCommands: [],
    historyLoading: false,
    hasMoreHistory: false,
    loadingEarlierHistory: false,
    loadEarlierMessages: jest.fn(),
    createNewSession: jest.fn(),
    deleteSessionById: jest.fn(),
    deleteLocalMessage: jest.fn(),
    disconnectGateway: jest.fn(),
    capabilitySnapshot: { methods: [], groups: [] },
    dynamicCommands: [],
    backends: [],
    selectedBackendId: undefined,
    selectBackend: jest.fn(),
    listBots: mockEnv.listBots,
    createBot: mockEnv.createBot,
    updateBot: jest.fn(),
    hasBotManagement: true,
    hasGroupRooms: true,
    openBot: mockEnv.openBot,
    clearBot: jest.fn(),
    botJobs: { list: jest.fn().mockResolvedValue([]), create: jest.fn(), pause: jest.fn() },
    botGroups: mockEnv.botGroups,
    selectedBotId: undefined,
    relatedWorkflows: [],
    gatewayRequest: jest.fn().mockResolvedValue({ sessions: [] }),
    requestedSurface: undefined,
    clearRequestedSurface: jest.fn(),
    requestedComposerFocus: undefined,
    clearRequestedComposerFocus: jest.fn(),
    requestedComposeRequest: undefined,
    clearRequestedComposeRequest: jest.fn(),
    ...patch,
  };
}

let renderer: ReactTestRenderer | null = null;

async function mount(patch: Record<string, unknown> = {}) {
  mockEnv.gateway = gatewayEnv(patch);
  await act(async () => {
    renderer = create(createElement(ChatScreen));
  });
  await settle();
}

/** Re-render the SAME screen with a new provider shape, as a status or a
 * gateway switch does — the screen stays mounted across both. */
async function redraw(patch: Record<string, unknown>) {
  mockEnv.gateway = { ...mockEnv.gateway, ...patch };
  await act(async () => {
    renderer?.update(createElement(ChatScreen));
  });
  await settle();
}

/** Let the microtask queue drain and the effects that follow it come due. */
async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

type RosterProps = {
  rows: { kind: string }[];
  loading: boolean;
  error?: string;
  onRefresh?: () => Promise<void>;
  onNewAgent?: () => void;
  onNewGroup?: () => void;
  onSelectBot?: (bot: PublicBot) => void;
  onSelectGroup?: (room: BotGroupRoom) => void;
};

type SheetProps = { visible: boolean; error?: string; onSubmit: (draft: unknown) => void };

type RoomProps = { group: BotGroupRoom; onSend: (text: string, mentionedIds: string[]) => Promise<unknown> };

/**
 * The props chat-screen handed one of its own components. Looked up by the
 * component function's name because `ChatRoster` is a `memo` wrapper and the
 * test tree exposes the implementation underneath it.
 */
function surface<T>(name: string): T | undefined {
  const match = renderer!.root.findAll(
    (node) => typeof node.type !== 'string' && (node.type as { name?: string }).name === name,
  )[0];
  return match?.props as T | undefined;
}

function roster(): RosterProps {
  const found = surface<RosterProps>('ChatRosterImpl');
  if (!found) throw new Error('the roster surface is not on screen');
  return found;
}

/** Every string the screen drew, flattened. */
function drawn(): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      const children = (node as { children?: unknown }).children;
      if (children) walk(children);
    }
  };
  walk(renderer!.toJSON());
  return out.join(' | ');
}

beforeEach(() => {
  // The 20s roster throttle is judged against `Date.now()`, so the window only
  // means anything against a clock this test controls.
  jest.useFakeTimers();
  mockCache = new Map();
  mockCacheGate = null;
  mockEnv.listBots.mockReset().mockResolvedValue([]);
  mockEnv.openBot.mockReset().mockResolvedValue(true);
  mockEnv.createBot.mockReset();
  mockEnv.listGroups.mockReset().mockResolvedValue([]);
  mockEnv.botGroups = {
    list: jest.fn((...args: unknown[]) => mockEnv.listGroups(...args)),
    create: jest.fn(),
    send: jest.fn().mockResolvedValue([]),
    history: jest.fn().mockResolvedValue([]),
    rename: jest.fn(),
    addMembers: jest.fn(),
    leave: jest.fn(),
    deleteGroup: jest.fn().mockResolvedValue(undefined),
  };
  mockEnv.gateway = gatewayEnv();
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
  }
  jest.useRealTimers();
});

describe('a roster read that never settled (ROSTER-1)', () => {
  test('the reconnect inside the throttle window reads again instead of spinning forever', async () => {
    // The link drops before the answer lands and comes back inside 20s — the
    // reconnect this app does many times a day. Both cancelled handlers return
    // before any state write, so nothing was left to clear `rosterLoading`; the
    // stamp taken before the read was issued kept the reconnect from reading,
    // and the roster rendered a bare skeleton: no rows, no error, no refresh
    // control, no retry.
    mockEnv.listBots.mockReturnValue(new Promise<PublicBot[]>(() => undefined));
    await mount();

    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);
    expect(roster().loading).toBe(true);

    await redraw({ status: 'reconnecting' });
    await advance(5_000);
    await redraw({ status: 'connected' });

    // The stamp belonged to a read that answered nothing, so it was refunded:
    // the reconnect gets its own read.
    expect(mockEnv.listBots).toHaveBeenCalledTimes(2);

    // And that read settles: the roster stops claiming it is loading.
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await redraw({ status: 'reconnecting' });
    await advance(5_000);
    await redraw({ status: 'connected' });
    await settle();
    expect(roster().loading).toBe(false);
    expect(roster().rows.some((row) => row.kind === 'bot')).toBe(true);
  });

  test('a read that DID answer keeps its throttle window', async () => {
    // The refund is scoped to a stamp nobody answered: a read that reached the
    // screen still absorbs the status flips the window exists for.
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();
    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);

    await redraw({ status: 'reconnecting' });
    await advance(1_000);
    await redraw({ status: 'connected' });

    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);
  });

  test('a refused read still names itself, and still defers only the retry', async () => {
    // The throttle was never meant to swallow a failure: the roster draws its
    // error line, and pull-to-refresh stays available. What the window defers is
    // the retry, nothing else.
    mockEnv.listBots.mockRejectedValue(new Error('the PC did not answer'));
    await mount();

    expect(roster().error).toContain('the PC did not answer');
    expect(roster().loading).toBe(false);
    expect(typeof roster().onRefresh).toBe('function');

    await redraw({ status: 'reconnecting' });
    await advance(1_000);
    await redraw({ status: 'connected' });
    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);
  });
});

describe('a roster refresh that outlives its gateway (V-1)', () => {
  test("the old gateway's Bots never paint under the new one", async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();
    expect(roster().rows.some((row) => row.kind === 'bot')).toBe(true);
    const store = jest.requireMock('@/lib/cache/swr-store') as { writeCached: jest.Mock };

    // Pull-to-refresh starts, and the operator switches gateways from another
    // drawer screen while `listBots` is still out.
    let answerA!: (bots: PublicBot[]) => void;
    const pendingA = new Promise<PublicBot[]>((resolve) => {
      answerA = resolve;
    });
    mockEnv.listBots.mockReturnValue(pendingA);
    const refreshing = roster().onRefresh!();
    await settle();

    // Gateway B's own read is asked and stays out, so the only thing that could
    // fill the rows is the answer for the gateway the operator just left.
    mockEnv.listBots.mockReturnValue(new Promise<PublicBot[]>(() => undefined));
    await redraw({ activeGateway: GATEWAY_B });
    // The switch re-keys the rows, so the screen claims no inventory at all...
    expect(roster().rows.some((row) => row.kind === 'bot')).toBe(false);

    // ...and gateway A's answer, asked of A's client, lands nowhere.
    store.writeCached.mockClear();
    answerA([bot('forge')]);
    await act(async () => {
      await refreshing;
    });
    await settle();

    expect(roster().rows.some((row) => row.kind === 'bot')).toBe(false);
    // Nor is it written as this device's remembered copy, or stamped as the
    // throttle's answer for a gateway that is gone.
    expect(store.writeCached).not.toHaveBeenCalled();
  });

  test('a refresh on the gateway the operator is still on still paints', async () => {
    mockEnv.listBots.mockResolvedValue([bot('one')]);
    await mount();

    mockEnv.listBots.mockResolvedValue([bot('one'), bot('two')]);
    await act(async () => {
      await roster().onRefresh!();
    });
    await settle();

    expect(roster().rows.some((row) => row.kind === 'bot')).toBe(true);
    const store = jest.requireMock('@/lib/cache/swr-store') as { writeCached: jest.Mock };
    expect(store.writeCached.mock.calls.at(-1)).toEqual([
      'roster',
      'gw-a',
      'bots',
      [bot('one'), bot('two')],
    ]);
  });
});

describe('a remembered roster is read for one gateway only', () => {
  test("a copy read for a gateway the screen left paints nothing", async () => {
    // `readCached` is this device's slowest read on the mount path, so it can be
    // in flight across a gateway switch. What keeps a copy read for the gateway
    // the operator LEFT off this screen is the effect's own teardown: it depends
    // on `activeGateway?.id`, so React cancels that read in the same commit the
    // switch is rendered in, before the storage answer can reach a writer. (V-2
    // claimed the fold's guard was defeated here; that window is not reachable.)
    let openCache!: () => void;
    mockCacheGate = new Promise<void>((resolve) => {
      openCache = resolve;
    });
    mockCache.set('roster:gw-a:bots', { value: [bot('from-a')], savedAt: Date.now() });
    mockEnv.listBots.mockReturnValue(new Promise<PublicBot[]>(() => undefined));
    await mount();

    await redraw({ activeGateway: GATEWAY_B });
    await act(async () => {
      openCache();
    });
    await settle();

    expect(drawn()).not.toContain('from-a');
    // The live read for B is what fills the roster now, not A's remembered copy.
    expect(roster().loading).toBe(true);
  });

  test("a gateway's own remembered copy still paints when nothing has answered", async () => {
    mockCache.set('roster:gw-a:bots', { value: [bot('from-a')], savedAt: Date.now() });
    mockEnv.listBots.mockReturnValue(new Promise<PublicBot[]>(() => undefined));
    await mount();

    expect(drawn()).toContain('from-a');
    expect(roster().loading).toBe(false);
  });
});

describe('a create whose follow-up read fails (BOT-3)', () => {
  test('the refusal is named on the roster, and the new Agent is not lost silently', async () => {
    mockEnv.createBot.mockResolvedValue({ id: 'newcomer', displayName: 'Newcomer', routable: false });
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();

    // The create lands on the Gate; the roster re-read that follows is refused
    // by the same lossy link.
    mockEnv.listBots.mockRejectedValue(new Error('the PC did not answer'));
    await act(async () => {
      roster().onNewAgent!();
    });
    await settle();
    await act(async () => {
      surface<SheetProps>('NewAgentSheet')!.onSubmit({
        name: 'Newcomer',
        description: 'a new agent',
        inheritKeys: false,
      });
    });
    await settle();

    // The sheet is closed — it is the roster the operator is looking at, and it
    // says the re-read failed instead of the message dying in the sheet.
    const sheet = surface<SheetProps>('NewAgentSheet')!;
    expect(sheet.visible).toBe(false);
    expect(roster().error).toContain('the PC did not answer');
  });

  test('a good follow-up read shows the new Agent and keeps it for a cold start', async () => {
    mockEnv.createBot.mockResolvedValue({ id: 'newcomer', displayName: 'Newcomer', routable: false });
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();

    mockEnv.listBots.mockResolvedValue([bot('forge'), bot('newcomer')]);
    await act(async () => {
      roster().onNewAgent!();
    });
    await settle();
    await act(async () => {
      surface<SheetProps>('NewAgentSheet')!.onSubmit({
        name: 'Newcomer',
        description: 'a new agent',
        inheritKeys: false,
      });
    });
    await settle();

    expect(drawn()).toContain('newcomer');
    const store = jest.requireMock('@/lib/cache/swr-store') as { writeCached: jest.Mock };
    expect(store.writeCached.mock.calls.at(-1)?.[3]).toEqual([bot('forge'), bot('newcomer')]);
  });

  test("a create that lands on another gateway's screen never paints there", async () => {
    // The create is asked of the gateway that was live when the form was sent,
    // and so is the roster re-read that follows it. A switch while it is in
    // flight must not put gateway A's answer under gateway B (V-1).
    let land!: (created: { id: string; displayName: string; routable: boolean }) => void;
    mockEnv.createBot.mockReturnValue(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    mockEnv.listBots.mockReturnValue(new Promise<PublicBot[]>(() => undefined));
    await mount();
    await act(async () => {
      roster().onNewAgent!();
    });
    await settle();
    await act(async () => {
      surface<SheetProps>('NewAgentSheet')!.onSubmit({
        name: 'Newcomer',
        description: 'a new agent',
        inheritKeys: false,
      });
    });
    await settle();

    // The store mock is module-level, so the writes the mount already made are
    // counted here too; only what lands from the switch onwards is under test.
    const store = jest.requireMock('@/lib/cache/swr-store') as { writeCached: jest.Mock };
    store.writeCached.mockClear();

    // Re-point the screen at gateway B the way the provider would, then let the
    // create land and its follow-up read answer with gateway A's roster.
    await redraw({ activeGateway: GATEWAY_B });
    await act(async () => {
      mockEnv.listBots.mockResolvedValue([bot('from-a')]);
      land({ id: 'newcomer', displayName: 'Newcomer', routable: false });
    });
    await settle();

    expect(drawn()).not.toContain('from-a');
    expect(roster().rows.some((row) => row.kind === 'bot')).toBe(false);
    // Nor is it written as this device's remembered copy for either gateway.
    expect(store.writeCached).not.toHaveBeenCalled();
  });

  test('a refused create still speaks in the sheet it was typed in', async () => {
    mockEnv.createBot.mockRejectedValue(new Error('the Gate refused the agent'));
    await mount();

    await act(async () => {
      roster().onNewAgent!();
    });
    await settle();
    await act(async () => {
      surface<SheetProps>('NewAgentSheet')!.onSubmit({
        name: 'Newcomer',
        description: 'a new agent',
        inheritKeys: false,
      });
    });
    await settle();

    const sheet = surface<SheetProps>('NewAgentSheet')!;
    expect(sheet.visible).toBe(true);
    expect(sheet.error).toBeTruthy();
  });
});

describe('a Bot open that answers false (OPEN-7)', () => {
  test('the operator goes back to the roster, not into an unnamed thread', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    // `openBot` answers a refusal instead of throwing: a client re-attach or a
    // second Bot open supersedes this one, so `isCurrent()` is false and the
    // answer is `false` with no lastError to draw.
    mockEnv.openBot.mockResolvedValue(false);
    await mount();

    await act(async () => {
      roster().onSelectBot!(bot('forge'));
    });
    await settle();

    expect(surface<RosterProps>('ChatRosterImpl')).toBeTruthy();
    expect(mockEnv.openBot).toHaveBeenCalledWith('forge');
  });

  test('an open that throws still falls back to the roster', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    mockEnv.openBot.mockRejectedValue(new Error('bots unavailable'));
    await mount();

    await act(async () => {
      roster().onSelectBot!(bot('forge'));
    });
    await settle();

    expect(surface<RosterProps>('ChatRosterImpl')).toBeTruthy();
  });

  test('an open that lands keeps the operator in that Bot Chat', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    mockEnv.openBot.mockResolvedValue(true);
    await mount();

    await act(async () => {
      roster().onSelectBot!(bot('forge'));
    });
    await settle();

    expect(surface<RosterProps>('ChatRosterImpl')).toBeUndefined();
    expect(mockEnv.openBot).toHaveBeenCalledWith('forge');
  });
});

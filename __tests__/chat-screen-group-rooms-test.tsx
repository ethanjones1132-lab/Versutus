// ─── The room list is an inventory too, and it is keyed ─────────────────────
// Three verified defects in the room half of the roster surface:
//   GATE-2   a room the Gate had just created became "This room is gone" whenever
//            the re-read that followed the create was refused on the same link.
//   GROUPS-4 nothing re-keyed `groupsState` on a gateway switch, so the previous
//            gateway's room name, member ids and room id stayed on screen — and
//            `botGroups.send` posted that id to the gateway the operator
//            switched TO.
//   GROUPS-5 `refreshGroups` carried no read identity, so a slower older read
//            could land last and put a renamed room's old name back on screen.
//
// The screen is rendered for real; only the provider seam, the design primitives
// and this device's own cached store stand in. Props are read off the components
// chat-screen itself draws.

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatScreen } from '@/components/chat/chat-screen';
import type { PublicBot } from '@/lib/gateway/bots';
import {
  applyGroupRead,
  applyGroupRoomKnown,
  EMPTY_GROUPS,
  groupsListCopy,
  resolveOpenGroup,
  type BotGroupRoom,
} from '@/lib/gateway/groups';

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
    commandTranscripts: [],
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
  groups: BotGroupRoom[];
  groupsError?: string;
  onRefresh?: () => Promise<void>;
  onNewAgent?: () => void;
  onNewGroup?: () => void;
  onSelectBot?: (bot: PublicBot) => void;
  onSelectGroup?: (room: BotGroupRoom) => void;
};

type SheetProps = { visible: boolean; error?: string; onSubmit: (draft: unknown) => void };

/**
 * The props chat-screen handed one of its own components. Looked up by the
 * component function's name because `ChatRoster` is a `memo` wrapper and the
 * test tree exposes the implementation underneath it.
 */
function surface<T>(name: string): T | undefined {
  const match = renderer!.root.findAll((node) =>
    typeof node.type === 'string'
      ? node.type === name
      : (node.type as { name?: string }).name === name,
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

type RoomSheetProps = {
  visible: boolean;
  busy?: boolean;
  error?: string;
  onCreate: (input: { name: string; memberIds: string[] }) => void;
};

type OpenRoomProps = { group: BotGroupRoom; onSend: (text: string, mentionedIds: string[]) => Promise<unknown> };

type EmptyStateProps = { title: string; description?: string; actionLabel?: string };

type HeaderProps = { groupName?: string; groupMemberIds?: string[]; backendLabel?: string };

function emptyState(): EmptyStateProps | undefined {
  return surface<EmptyStateProps>('EmptyState');
}

/** What the one-row header names for this surface. */
function header(): HeaderProps | undefined {
  return surface<HeaderProps>('ChatHeaderImpl');
}

describe('a room the Gate just created (GATE-2)', () => {
  test('a refused re-read after the create still opens the room it made', async () => {
    // The Gate answers the create, then the immediate `/v1/bot-groups` re-read
    // rides the same lossy link and fails. `applyGroupRead` keeps the previous
    // list, so the room the Gate had just created was absent from a list that
    // claims to be read — and the open-room verdict turned that into "This room
    // is gone", with "Back to the roster" as the only way out of a room that
    // exists on the PC.
    const crew = room('room-a');
    mockEnv.listGroups.mockResolvedValue([crew]);
    mockEnv.listBots.mockResolvedValue([bot('one'), bot('two')]);
    await mount();
    expect(roster().groups).toEqual([crew]);

    const created = room('room-new');
    mockEnv.botGroups.create.mockResolvedValue(created);
    // The re-read that follows the create is refused.
    mockEnv.listGroups.mockRejectedValue(new Error('the PC did not answer'));

    await act(async () => {
      roster().onNewGroup!();
    });
    await settle();
    await act(async () => {
      surface<RoomSheetProps>('CreateGroupSheet')!.onCreate({
        name: 'crew',
        memberIds: ['one', 'two'],
      });
    });
    await settle();

    // The room the Gate created is the room on screen, not a "gone" verdict.
    expect(surface<OpenRoomProps>('GroupRoomView')?.group).toEqual(created);
    expect(emptyState()?.title).not.toBe('This room is gone');
  });

  test('a create whose re-read succeeds opens the room from the fresh list', async () => {
    mockEnv.listGroups.mockResolvedValue([]);
    mockEnv.listBots.mockResolvedValue([bot('one'), bot('two')]);
    await mount();

    const created = room('room-new');
    mockEnv.botGroups.create.mockResolvedValue(created);
    mockEnv.listGroups.mockResolvedValue([created]);

    await act(async () => {
      roster().onNewGroup!();
    });
    await settle();
    await act(async () => {
      surface<RoomSheetProps>('CreateGroupSheet')!.onCreate({
        name: 'crew',
        memberIds: ['one', 'two'],
      });
    });
    await settle();

    expect(surface<OpenRoomProps>('GroupRoomView')?.group).toEqual(created);
    expect(emptyState()?.title).not.toBe('This room is gone');
  });

  test('a refused re-read still names itself beside the rooms it kept', () => {
    // The refusal is not swallowed by the fold that keeps the room: the roster
    // line says the list is stale, which is what makes the kept list honest.
    const previous = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [room('room-a')] });
    const folded = applyGroupRead(applyGroupRoomKnown(previous, room('room-new')), { ok: false });
    expect(groupsListCopy(folded)).toContain('last list');
  });
});

describe('applyGroupRoomKnown', () => {
  test('a room the Gate answered for survives a failed re-read', () => {
    // The fold chain the create path used to skip: a list that was read, a
    // re-read that failed, and the verdict the open-room surface draws from it.
    const previous = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [room('room-a')] });
    expect(resolveOpenGroup('room-new', applyGroupRead(previous, { ok: false }))).toEqual({ kind: 'gone' });

    const folded = applyGroupRoomKnown(previous, room('room-new'));
    expect(folded.rooms.map((entry) => entry.id)).toEqual(['room-a', 'room-new']);
    expect(resolveOpenGroup('room-new', applyGroupRead(folded, { ok: false }))).toEqual({
      kind: 'open',
      room: room('room-new'),
    });
  });

  test('a room already listed is replaced, not duplicated', () => {
    const previous = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [room('room-a')] });
    const renamed = { ...room('room-a'), name: 'renamed' };
    const folded = applyGroupRoomKnown(previous, renamed);
    expect(folded.rooms).toEqual([renamed]);
  });

  test('the inventory is not marked read by one room', () => {
    // `loaded` is what the missing-room verdict trusts, so folding one known
    // room must not claim the whole list was read.
    const folded = applyGroupRoomKnown(EMPTY_GROUPS, room('room-new'));
    expect(folded.loaded).toBe(false);
    expect(resolveOpenGroup('other', folded)).toEqual({ kind: 'unread' });
  });
});

describe('the room list across a gateway switch (GROUPS-4)', () => {
  test("the previous gateway's room is neither drawn nor sendable", async () => {
    const crew = { id: 'room-a', name: 'crew', memberIds: ['one', 'two'] };
    mockEnv.listGroups.mockResolvedValue([crew]);
    mockEnv.listBots.mockResolvedValue([bot('one'), bot('two')]);
    await mount();

    await act(async () => {
      roster().onSelectGroup!(crew);
    });
    await settle();
    expect(surface<OpenRoomProps>('GroupRoomView')?.group).toEqual(crew);
    expect(header()?.groupName).toBe('crew');

    // The gateway is switched from a sibling drawer screen while this screen
    // stays mounted on the room.
    await redraw({ activeGateway: GATEWAY_B });

    // Gateway A's room is gone from here: no room name and no member ids in the
    // header, no room view, and nothing that would post that room id to gateway
    // B. What is left says the rooms could not be read, which is what an
    // inventory for a gateway this screen has not asked yet really is.
    expect(surface<OpenRoomProps>('GroupRoomView')).toBeUndefined();
    expect(header()?.groupName).toBeUndefined();
    expect(header()?.groupMemberIds).toBeUndefined();
    expect(emptyState()?.title).toBe('Rooms could not be read');
  });

  test('the rooms the new gateway does list are read for the new gateway', async () => {
    mockEnv.listGroups.mockResolvedValue([]);
    mockEnv.listBots.mockResolvedValue([]);
    await mount();

    const atticRoom = { id: 'room-b', name: 'attic-crew', memberIds: ['three', 'four'] };
    mockEnv.listGroups.mockResolvedValue([atticRoom]);
    await redraw({ activeGateway: GATEWAY_B });

    expect(roster().groups).toEqual([atticRoom]);
    expect(mockEnv.listGroups).toHaveBeenCalled();
  });
});

describe('two room reads at once (GROUPS-5)', () => {
  test('a slower older read cannot put the old name back', async () => {
    // The roster read re-runs on every `status` flip and a rename fires one of
    // its own, so two reads of different vintages are routinely in flight on a
    // lossy link.
    let answerFirst!: (rooms: BotGroupRoom[]) => void;
    const first = new Promise<BotGroupRoom[]>((resolve) => {
      answerFirst = resolve;
    });
    let answerSecond!: (rooms: BotGroupRoom[]) => void;
    const second = new Promise<BotGroupRoom[]>((resolve) => {
      answerSecond = resolve;
    });
    mockEnv.listGroups.mockReturnValueOnce(first).mockReturnValueOnce(second);
    await mount();
    expect(roster().groups).toEqual([]);

    // A reconnect re-reads while the first read is still out.
    await redraw({ status: 'reconnecting' });
    await advance(1_000);
    await redraw({ status: 'connected' });
    expect(mockEnv.listGroups).toHaveBeenCalledTimes(2);

    // The newer read answers with the renamed room...
    const renamed = { id: 'room-a', name: 'crew-renamed', memberIds: ['one', 'two'] };
    answerSecond([renamed]);
    await settle();
    expect(roster().groups).toEqual([renamed]);

    // ...and the older one lands last with the name from before the rename.
    answerFirst([{ id: 'room-a', name: 'crew', memberIds: ['one', 'two'] }]);
    await settle();

    expect(roster().groups).toEqual([renamed]);
  });

  test('a read whose gateway is gone lands nowhere', async () => {
    let answerA!: (rooms: BotGroupRoom[]) => void;
    const pendingA = new Promise<BotGroupRoom[]>((resolve) => {
      answerA = resolve;
    });
    mockEnv.listGroups.mockReturnValue(pendingA);
    await mount();

    // Gateway B's own read is asked and stays out, so the only thing that could
    // fill the room list is an answer for the gateway just left.
    mockEnv.listGroups.mockReturnValue(new Promise<BotGroupRoom[]>(() => undefined));
    await redraw({ activeGateway: GATEWAY_B });
    answerA([room('room-a')]);
    await settle();

    expect(roster().groups).toEqual([]);
  });
});

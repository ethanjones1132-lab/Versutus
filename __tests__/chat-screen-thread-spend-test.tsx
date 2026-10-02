// ─── The wide catalogue read is a fallback, not a per-turn bill ─────────────
// The spend glance asks for a narrow 50-row window and widens to the whole
// 200-row catalogue only when the open thread is missing from it. A thread that
// is not among the newest 50 is normal — a Bot Chat reused daily while other
// sessions are created — and every finished turn re-ran the effect, so that
// thread paid 50 + 200 rows after each one, seconds apart, on a single-
// threaded Gate (SPEND-6). The wide read now has a cooldown of its own.

// The screen is rendered for real; only the provider seam, the design
// primitives and this device's own cached store stand in. The `sessions.list`
// RPC is the seam under test: what the glance asked the Gate for, and how
// often.

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatScreen } from '@/components/chat/chat-screen';
import type { PublicBot } from '@/lib/gateway/bots';
import type { BotGroupRoom } from '@/lib/gateway/groups';
import {
  SESSION_SPEND_LIST_LIMIT,
  THREAD_SPEND_GLANCE_LIMIT,
  THREAD_SPEND_WIDE_MIN_READ_MS,
  threadSpendWideReadDue,
} from '@/lib/gateway/session-analytics';

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

const GATEWAY_A = { id: 'gw-a', name: 'Studio', model: 'm', modelLocks: [] };

function bot(id: string): PublicBot {
  return { id, displayName: id, routable: true };
}

type GatewayEnv = {
  gateway: Record<string, unknown>;
  chatSurface: { messages: unknown[]; isSending: boolean; isCommandRunning: boolean };
  request: jest.Mock;
  listBots: jest.Mock;
  openBot: jest.Mock;
  createBot: jest.Mock;
  listGroups: jest.Mock;
  botGroups: Record<string, jest.Mock>;
};

const mockEnv: GatewayEnv = {
  gateway: {},
  chatSurface: { messages: [], isSending: false, isCommandRunning: false },
  request: jest.fn(),
  listBots: jest.fn(),
  openBot: jest.fn(),
  createBot: jest.fn(),
  listGroups: jest.fn(),
  botGroups: {},
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockEnv.gateway,
  // The spend glance keys its re-read on a turn FINISHING, so the turn state has
  // to be something the test can move.
  useChatSurface: () => mockEnv.chatSurface,
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
    currentSessionId: 'thread-1',
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
    gatewayRequest: mockEnv.request,
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
  onSelectBot?: (bot: PublicBot) => void;
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
  // The 20s roster throttle and the glance's own minimum gap are both judged
  // against `Date.now()`, so the windows only mean anything against a clock
  // this test controls.
  jest.useFakeTimers();
  mockCache = new Map();
  mockCacheGate = null;
  mockEnv.chatSurface = { messages: [], isSending: false, isCommandRunning: false };
  // A sessions catalogue that does NOT hold the open thread — the case the wide
  // read exists for, and the one a reused Bot Chat lives in.
  mockEnv.request.mockReset().mockResolvedValue({
    sessions: [
      { id: 'other-1', input_tokens: 10, output_tokens: 5, actual_cost_usd: 0.01 },
      { id: 'other-2', input_tokens: 20, output_tokens: 10, actual_cost_usd: 0.02 },
    ],
  });
  mockEnv.listBots.mockReset().mockResolvedValue([bot('forge')]);
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
  mockEnv.gateway = gatewayEnv({ currentSessionId: 'thread-1' });
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
/** Every `sessions.list` the glance asked the Gate for, by its window. */
function sessionListCalls(): number[] {
  return mockEnv.request.mock.calls
    .filter(([method]) => method === 'sessions.list')
    .map(([, params]) => (params as { limit: number }).limit);
}

async function openBotThread() {
  await act(async () => {
    roster().onSelectBot!(bot('forge'));
  });
  await settle();
}

/** One turn: a send that starts, and a finish far enough from the last read. */
async function finishTurn() {
  mockEnv.chatSurface = { ...mockEnv.chatSurface, isSending: true };
  await redraw({});
  await advance(11_000);
  mockEnv.chatSurface = { ...mockEnv.chatSurface, isSending: false };
  await redraw({});
  await settle();
}

describe('the spend glance on a thread outside the newest 50 (SPEND-6)', () => {
  test('opening the thread spends one narrow read and one wide read', async () => {
    await mount();
    await openBotThread();

    // The narrow window first, then the one wide read that covers this thread.
    expect(sessionListCalls()).toEqual([THREAD_SPEND_GLANCE_LIMIT, SESSION_SPEND_LIST_LIMIT]);
  });

  test('a turn finishing does not buy another 200-row read', async () => {
    await mount();
    await openBotThread();
    expect(sessionListCalls()).toEqual([THREAD_SPEND_GLANCE_LIMIT, SESSION_SPEND_LIST_LIMIT]);

    await finishTurn();
    await finishTurn();

    // Two more narrow reads (one per finished turn) and no catalogue read at
    // all: before, every turn on a thread outside the newest 50 paid 50 + 200
    // rows on a single-threaded Gate, seconds apart, on the screen the operator
    // was watching.
    expect(sessionListCalls()).toEqual([
      THREAD_SPEND_GLANCE_LIMIT,
      SESSION_SPEND_LIST_LIMIT,
      THREAD_SPEND_GLANCE_LIMIT,
      THREAD_SPEND_GLANCE_LIMIT,
    ]);
  });

  test('the wide read comes back once the cooldown has passed', async () => {
    await mount();
    await openBotThread();

    await advance(THREAD_SPEND_WIDE_MIN_READ_MS + 1_000);
    await finishTurn();

    // Past the cooldown the thread still outside the newest 50 is covered
    // again — the glance is paced, not switched off.
    expect(sessionListCalls()).toEqual([
      THREAD_SPEND_GLANCE_LIMIT,
      SESSION_SPEND_LIST_LIMIT,
      THREAD_SPEND_GLANCE_LIMIT,
      SESSION_SPEND_LIST_LIMIT,
    ]);
  });

  test('a turn starting costs nothing, and its finish costs one narrow read', async () => {
    await mount();
    await openBotThread();
    const before = sessionListCalls().length;

    mockEnv.chatSurface = { ...mockEnv.chatSurface, isSending: true };
    await redraw({});
    await advance(30_000);
    // The start edge moves no key: nothing is read under the turn.
    expect(sessionListCalls()).toHaveLength(before);

    mockEnv.chatSurface = { ...mockEnv.chatSurface, isSending: false };
    await redraw({});
    await settle();
    // The finish does read — once, and narrow.
    expect(sessionListCalls().slice(before)).toEqual([THREAD_SPEND_GLANCE_LIMIT]);
  });
});

describe('threadSpendWideReadDue', () => {
  test('a surface that has never widened reads at once', () => {
    expect(threadSpendWideReadDue({ lastWideAt: undefined, now: 1_000 })).toBe(true);
  });

  test('a second wide read waits for the cooldown', () => {
    const lastWideAt = 1_000;
    expect(threadSpendWideReadDue({ lastWideAt, now: lastWideAt + 1 })).toBe(false);
    expect(threadSpendWideReadDue({ lastWideAt, now: lastWideAt + THREAD_SPEND_WIDE_MIN_READ_MS - 1 })).toBe(false);
    expect(threadSpendWideReadDue({ lastWideAt, now: lastWideAt + THREAD_SPEND_WIDE_MIN_READ_MS })).toBe(true);
  });

  test('the cooldown is wider than the glance minimum gap, which is the point', () => {
    // The narrow read's own floor is 10s; a thread outside the newest 50 used
    // to be re-read at that rate for the whole 200-row catalogue.
    expect(THREAD_SPEND_WIDE_MIN_READ_MS).toBeGreaterThan(10_000);
  });
});

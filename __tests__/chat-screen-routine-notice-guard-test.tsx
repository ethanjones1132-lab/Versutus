// ─── A fire-and-forget that can reject needs a handler ─────────────────────
// Every other fire-and-forget on this screen ends in `.catch(() => undefined)`.
// These four did not, and they sit on helpers that CAN reject: `serialiseSync`
// hands back whatever the work rejected with, and `rearmRoutineNotifications`
// fans out with `Promise.all`, so the first rejection propagates to a bare
// `void` — an unhandled promise rejection on the device, with nothing on screen
// to explain it (NOTIF-9).
//
// The helpers are stood in for by a thenable that records whether the call site
// attached a rejection handler at all: that is the whole contract, and it is read
// off the real screen through the real Bot Chat routine read, create and pause
// paths.

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatScreen } from '@/components/chat/chat-screen';
import type { PublicBot } from '@/lib/gateway/bots';

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
  botJobs: Record<string, jest.Mock>;
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
  botJobs: {},
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
    commandTranscripts: [],
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
    botJobs: mockEnv.botJobs,
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



/**
 * One fire-and-forget, as the call site saw it: a promise that rejects, and a
 * record of whether the site handled it. A `void` with no handler leaves the
 * record empty — which is the defect this file exists for.
 */
type Fired = { helper: string; handled: boolean };
let mockFired: Fired[] = [];
function mockFireAndForget(helper: string) {
  const record: Fired = { helper, handled: false };
  mockFired.push(record);
  const rejecting = Promise.reject(new Error(`${helper} refused`));
  // Keep node quiet about the rejection itself; what is under test is whether
  // the CALL SITE attached a handler, not whether node complains.
  rejecting.catch(() => undefined);
  return {
    then: (...args: unknown[]) => (rejecting as unknown as { then: (...a: unknown[]) => unknown }).then(...args),
    catch: (...args: unknown[]) => {
      record.handled = true;
      return (rejecting as unknown as { catch: (...a: unknown[]) => unknown }).catch(...args);
    },
  };
}

jest.mock('@/lib/notifications/routine-sync', () => ({
  syncRoutineNotification: (job: unknown) => mockFireAndForget(`sync:${(job as { id?: string }).id ?? ''}`),
  cancelRoutineNotification: (jobId: string) => mockFireAndForget(`cancel:${jobId}`),
  rearmRoutineNotifications: (jobs: unknown[]) =>
    mockFireAndForget(`rearm:${(jobs as { id: string }[]).map((job) => job.id).join(',')}`),
  reconcileRoutineNotices: () => mockFireAndForget('reconcile'),
}));
type RoutinesPaneProps = {
  jobs: { id: string; name?: string; schedule?: string; paused?: boolean }[];
  onCreate: (input: { title: string; prompt: string; schedule: string }) => Promise<void>;
  onTogglePause: (jobId: string, paused: boolean) => Promise<void>;
};

beforeEach(() => {
  jest.useFakeTimers();
  mockCache = new Map();
  mockCacheGate = null;
  mockFired = [];
  mockEnv.chatSurface = { messages: [], isSending: false, isCommandRunning: false };
  mockEnv.request.mockReset().mockResolvedValue({ sessions: [] });
  mockEnv.listBots.mockReset().mockResolvedValue([bot('forge')]);
  mockEnv.openBot.mockReset().mockResolvedValue(true);
  mockEnv.createBot.mockReset();
  mockEnv.listGroups.mockReset().mockResolvedValue([]);
  mockEnv.botJobs = {
    list: jest.fn().mockResolvedValue([
      { id: 'job-1', name: '[bot:forge] Standup', schedule: '0 9 * * *' },
    ]),
    create: jest.fn().mockResolvedValue({
      id: 'job-2',
      name: '[bot:forge] Standup',
      schedule: '0 9 * * *',
    }),
    pause: jest.fn().mockResolvedValue(undefined),
  };
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
  mockEnv.gateway = gatewayEnv({ botJobs: mockEnv.botJobs, currentSessionId: 'thread-1' });
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

/** Open the Bot Chat, where the routine read and the routine actions live. */
async function openBotThread() {
  await act(async () => {
    roster().onSelectBot!(bot('forge'));
  });
  await settle();
}

function pane(): RoutinesPaneProps {
  const found = surface<RoutinesPaneProps>('RoutinesPaneImpl');
  if (!found) throw new Error('the routines pane is not on screen');
  return found;
}

function handledFor(helper: string): boolean | undefined {
  return mockFired.find((entry) => entry.helper === helper)?.handled;
}

describe('the routine notice fire-and-forgets (NOTIF-9)', () => {
  test('the re-arm that follows a Bot Chat routine read handles its rejection', async () => {
    await mount();
    await openBotThread();

    expect(mockFired.map((entry) => entry.helper)).toContain('rearm:job-1');
    expect(handledFor('rearm:job-1')).toBe(true);
  });

  test('the sync after a confirmed create handles its rejection', async () => {
    await mount();
    await openBotThread();

    await act(async () => {
      await pane().onCreate({ title: 'Standup', prompt: 'summarise the day', schedule: '0 9 * * *' });
    });
    await settle();

    expect(mockEnv.botJobs.create).toHaveBeenCalled();
    expect(mockFired.map((entry) => entry.helper)).toContain('sync:job-2');
    expect(handledFor('sync:job-2')).toBe(true);
  });

  test('a pause retires its notice with a handled rejection', async () => {
    await mount();
    await openBotThread();

    await act(async () => {
      await pane().onTogglePause('job-1', true);
    });
    await settle();

    expect(handledFor('cancel:job-1')).toBe(true);
  });

  test('a resume re-arms the notice with a handled rejection', async () => {
    await mount();
    await openBotThread();

    await act(async () => {
      await pane().onTogglePause('job-1', false);
    });
    await settle();

    expect(mockFired.map((entry) => entry.helper)).toContain('sync:job-1');
    expect(handledFor('sync:job-1')).toBe(true);
  });

  test('nothing this screen fires leaves an unhandled rejection behind', async () => {
    await mount();
    await openBotThread();
    await act(async () => {
      await pane().onCreate({ title: 'Standup', prompt: 'summarise the day', schedule: '0 9 * * *' });
    });
    await settle();
    await act(async () => {
      await pane().onTogglePause('job-1', true);
    });
    await settle();
    await act(async () => {
      await pane().onTogglePause('job-1', false);
    });
    await settle();

    expect(mockFired.length).toBeGreaterThan(0);
    expect(mockFired.filter((entry) => !entry.handled)).toEqual([]);
  });
});

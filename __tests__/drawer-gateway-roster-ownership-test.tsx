import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SideDrawerContent } from '@/components/nav/side-drawer-content';
import type { PublicBot } from '@/lib/gateway/bots';

// VS-004: the drawer is mounted beside every screen for the life of the app, so
// it outlives every gateway switch. Its roster, the line beside it, and the
// press targets those rows carry used to belong to "whatever was painted last":
// after A -> B with no B cache and a refused B read, A's Bots stayed on screen
// under B and stayed actionable. These pin the ownership boundary by gateway
// identity — not by source strings, which is why every case mounts the drawer.

jest.mock('react-native-reanimated', () => {
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_target, key) => (key === 'then' ? undefined : proxy),
      apply: () => proxy,
    });
    return proxy;
  };
  const easing = new Proxy(
    { bezier: () => (value: number) => value },
    {
      get: (target, key) =>
        key in target
          ? (target as unknown as Record<string | symbol, unknown>)[key]
          : () => (value: number) => value,
    },
  ) as Record<string, unknown>;
  return {
    default: { View: 'Animated.View', createAnimatedComponent: (component: unknown) => component },
    Easing: easing,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    cancelAnimation: () => undefined,
    View: 'Animated.View',
    Text: 'Animated.Text',
    ScrollView: 'Animated.ScrollView',
    createAnimatedComponent: (component: unknown) => component,
    runOnJS: (fn: unknown) => fn,
    FadeIn: { duration: chain, easing: chain, delay: chain },
    FadeInDown: { duration: chain, easing: chain, delay: chain },
    FadeOut: { duration: chain, easing: chain },
    Layout: { duration: chain, easing: chain },
    LinearTransition: { duration: chain, easing: chain },
    Keyframe: class {
      duration() {
        return this;
      }

      easing() {
        return this;
      }
    },
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: (...args: unknown[]) => mockEnv.push(...args) }) }));
jest.mock('expo-router/drawer', () => ({ DrawerContentScrollView: 'DrawerContentScrollView' }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/components/chat/bot-avatar', () => ({ BotAvatar: 'BotAvatar' }));
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: 'Canvas',
  Fill: 'Fill',
  Shader: 'Shader',
  Skia: {},
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
}));
jest.mock('@/lib/haptics', () => ({ haptics: { selection: () => Promise.resolve() } }));

/** The shared roster cache, one copy per gateway — exactly as production keys it. */
let mockCache: Map<string, { value: PublicBot[]; savedAt: number }>;
let mockCacheReadGate: Promise<void> | null = null;
jest.mock('@/lib/cache/swr-store', () => ({
  readCached: jest.fn(async (ns: string, gatewayId: string, key: string) => {
    const entry = mockCache.get(`${ns}:${gatewayId}:${key}`) ?? null;
    if (mockCacheReadGate) await mockCacheReadGate;
    return entry;
  }),
  writeCached: jest.fn(async (ns: string, gatewayId: string, key: string, value: PublicBot[]) => {
    mockCache.set(`${ns}:${gatewayId}:${key}`, { value, savedAt: Date.now() });
  }),
}));

let mockEnv: {
  push: jest.Mock;
  listBots: jest.Mock;
  openBot: jest.Mock;
  requestSurface: jest.Mock;
  clearBot: jest.Mock;
  closeDrawer: jest.Mock;
  gateway: Record<string, unknown>;
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockEnv.gateway }));

function bot(id: string): PublicBot {
  return { id, displayName: id, routable: true } as unknown as PublicBot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function drawProps(gatewayPatch: Record<string, unknown> = {}) {
  mockEnv.gateway = { ...mockEnv.gateway, ...gatewayPatch };
  return {
    navigation: { closeDrawer: mockEnv.closeDrawer },
    state: {
      routes: [{ name: 'chat', key: 'chat-route' }],
      index: 0,
      key: 'drawer',
      routeNames: ['chat'],
    },
    descriptors: {},
    route: { key: 'drawer' },
  };
}

function drawDrawer(gatewayPatch: Record<string, unknown> = {}) {
  return create(createElement(SideDrawerContent, drawProps(gatewayPatch) as never));
}

/** Re-render the SAME mounted drawer with a new provider shape, as a switch or status flip does. */
async function redraw(gatewayPatch: Record<string, unknown>) {
  await act(async () => {
    renderer?.update(createElement(SideDrawerContent, drawProps(gatewayPatch) as never));
  });
  await settle();
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Everything the drawer put on screen, as one flat list of strings. */
function texts(renderer: ReactTestRenderer): string {
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
  walk(renderer.toJSON());
  return out.join(' | ');
}

/** Every Bot row the drawer is currently offering to press, one label each. */
function chatRows(renderer: ReactTestRenderer): string[] {
  const labels = renderer.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
    .map((node) => node.props.accessibilityLabel as string)
    .filter((label) => label.startsWith('Chat with '));
  return Array.from(new Set(labels));
}

/** The rendered row for one Bot, as mounted. */
function chatRow(renderer: ReactTestRenderer, title: string) {
  const row = renderer.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
    .find((node) => (node.props.accessibilityLabel as string).startsWith(`Chat with ${title}`));
  if (!row) throw new Error(`no Bot row "${title}"`);
  return row;
}

/** Press the first rendered row whose accessibility label matches. */
async function pressLabel(renderer: ReactTestRenderer, fragment: string) {
  const row = renderer.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
    .find((node) => node.props.accessibilityLabel.includes(fragment));
  if (!row) throw new Error(`no row labelled with "${fragment}"`);
  await act(async () => {
    await row.props.onPress();
  });
  await settle();
}

let renderer: ReactTestRenderer | null = null;

const GATE_A = { id: 'gate-a', name: 'Studio' };
const GATE_B = { id: 'gate-b', name: 'Field' };

beforeEach(() => {
  jest.useFakeTimers();
  mockCache = new Map();
  mockCacheReadGate = null;
  mockEnv = {
    push: jest.fn() as unknown as jest.Mock,
    listBots: jest.fn(() => new Promise<PublicBot[]>(() => undefined)) as unknown as jest.Mock,
    openBot: jest.fn() as unknown as jest.Mock,
    requestSurface: jest.fn() as unknown as jest.Mock,
    clearBot: jest.fn() as unknown as jest.Mock,
    closeDrawer: jest.fn() as unknown as jest.Mock,
    gateway: {},
  };
  mockEnv.gateway = {
    status: 'connected',
    statusDetail: undefined,
    activeGateway: GATE_A,
    gateways: [GATE_A],
    settings: {},
    listBots: () => mockEnv.listBots(),
    openBot: (id: string) => mockEnv.openBot(id),
    requestSurface: (value: unknown) => mockEnv.requestSurface(value),
    clearBot: () => mockEnv.clearBot(),
    pendingApprovals: [],
    activityRunsForActiveGateway: [],
  };
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

async function mount(patch: Record<string, unknown> = {}) {
  await act(async () => {
    renderer = drawDrawer(patch);
  });
  await settle();
}

describe('the drawer roster belongs to the gateway that read it', () => {
  test('A -> B with no B cache drops A before B answers', async () => {
    mockEnv.listBots.mockResolvedValueOnce([bot('alpha')]);
    await mount();
    expect(texts(renderer!)).toContain('alpha');
    expect(chatRows(renderer!)).toEqual(['Chat with alpha']);

    // A press that started on A's row and is still in flight when the switch
    // lands must not open A's Bot under B.
    const staleAlphaPress = chatRow(renderer!, 'alpha').props.onPress as () => Promise<void>;

    // B has no cached copy and its read has not answered yet. A's roster was
    // the last one painted, but it is not B's to show — or to open.
    const bLive = deferred<PublicBot[]>();
    mockEnv.listBots.mockReturnValueOnce(bLive.promise);
    await redraw({ activeGateway: GATE_B, gateways: [GATE_A, GATE_B] });

    expect(texts(renderer!)).not.toContain('alpha');
    expect(chatRows(renderer!)).toEqual([]);

    await act(async () => {
      await staleAlphaPress();
    });
    await settle();
    expect(mockEnv.openBot).not.toHaveBeenCalled();
    expect(mockEnv.push).not.toHaveBeenCalled();

    // When B answers, the row it offers is B's, and pressing it opens B's Bot.
    mockEnv.openBot.mockResolvedValue(true);
    await act(async () => {
      bLive.resolve([bot('beta')]);
    });
    await settle();

    expect(chatRows(renderer!)).toEqual(['Chat with beta']);
    await pressLabel(renderer!, 'Chat with beta');
    expect(mockEnv.openBot).toHaveBeenCalledWith('beta');
    expect(mockEnv.openBot).not.toHaveBeenCalledWith('alpha');
    expect(mockEnv.requestSurface).toHaveBeenCalledWith({ kind: 'bot', botId: 'beta' });
  });

  test('a refused B read shows B\'s error, never A\'s actionable rows', async () => {
    mockEnv.listBots.mockResolvedValueOnce([bot('alpha')]);
    await mount();
    expect(chatRows(renderer!)).toEqual(['Chat with alpha']);

    mockEnv.listBots.mockRejectedValueOnce(new Error('roster refused'));
    await redraw({ activeGateway: GATE_B, gateways: [GATE_A, GATE_B] });

    // Nothing of A's is left to press under B...
    expect(texts(renderer!)).not.toContain('alpha');
    expect(chatRows(renderer!)).toEqual([]);
    // ...but B's failed read still says so, and still offers the retry.
    expect(texts(renderer!)).toContain('Your team');
    expect(texts(renderer!)).toContain("Couldn't refresh your team");
    expect(texts(renderer!)).toContain('tap to retry');

    // The retry reads B again; A's id is never sent to open.
    mockEnv.listBots.mockRejectedValueOnce(new Error('still refused'));
    await pressLabel(renderer!, 'Tap to retry');
    expect(mockEnv.openBot).not.toHaveBeenCalled();
    expect(chatRows(renderer!)).toEqual([]);
  });

  test('delayed A cache and live completions cannot repaint B', async () => {
    // A's cache read is parked (a cold Android start) and its live read is
    // still out. B has its own remembered roster and its live read never comes.
    mockCache.set('roster:gate-a:bots', { value: [bot('alpha-cached')], savedAt: Date.now() });
    let releaseACache!: () => void;
    mockCacheReadGate = new Promise<void>((resolve) => {
      releaseACache = () => resolve();
    });
    const aLive = deferred<PublicBot[]>();
    mockEnv.listBots.mockReturnValueOnce(aLive.promise);
    await mount();

    mockCacheReadGate = null;
    mockCache.set('roster:gate-b:bots', { value: [bot('beta-cached')], savedAt: Date.now() });
    mockEnv.listBots.mockReturnValueOnce(new Promise<PublicBot[]>(() => undefined));
    await redraw({ activeGateway: GATE_B, gateways: [GATE_A, GATE_B] });
    expect(texts(renderer!)).toContain('beta-cached');
    expect(texts(renderer!)).not.toContain('alpha-cached');

    // A's read finally lands — after B is already on screen.
    await act(async () => {
      releaseACache();
    });
    await act(async () => {
      aLive.resolve([bot('alpha-live')]);
    });
    await settle();

    expect(texts(renderer!)).toContain('beta-cached');
    expect(texts(renderer!)).not.toContain('alpha-cached');
    expect(texts(renderer!)).not.toContain('alpha-live');
    expect(chatRows(renderer!)).toEqual(['Chat with beta-cached']);
  });

  test('B paints its cache, then B\'s live answer replaces it', async () => {
    mockCache.set('roster:gate-b:bots', { value: [bot('beta-cached')], savedAt: Date.now() });
    const bLive = deferred<PublicBot[]>();
    mockEnv.listBots.mockReturnValueOnce(bLive.promise);

    await mount({ activeGateway: GATE_B, gateways: [GATE_A, GATE_B] });
    expect(texts(renderer!)).toContain('beta-cached');
    expect(chatRows(renderer!)).toEqual(['Chat with beta-cached']);

    mockEnv.openBot.mockResolvedValue(true);
    await act(async () => {
      bLive.resolve([bot('beta-live')]);
    });
    await settle();

    expect(texts(renderer!)).toContain('beta-live');
    expect(texts(renderer!)).not.toContain('beta-cached');

    await pressLabel(renderer!, 'Chat with beta-live');
    expect(mockEnv.openBot).toHaveBeenCalledWith('beta-live');
    expect(mockEnv.openBot).not.toHaveBeenCalledWith('alpha');
    expect(mockEnv.requestSurface).toHaveBeenCalledWith({ kind: 'bot', botId: 'beta-live' });
  });

  test('B keeps its own remembered rows through a refused B refresh', async () => {
    mockEnv.listBots.mockResolvedValueOnce([bot('alpha')]);
    await mount();
    expect(chatRows(renderer!)).toEqual(['Chat with alpha']);

    // B's own last-good copy is remembered; its live refresh is refused.
    mockCache.set('roster:gate-b:bots', { value: [bot('beta-cached')], savedAt: Date.now() });
    mockEnv.listBots.mockRejectedValueOnce(new Error('roster refused'));
    await redraw({ activeGateway: GATE_B, gateways: [GATE_A, GATE_B] });

    expect(texts(renderer!)).toContain('beta-cached');
    expect(texts(renderer!)).not.toContain('alpha');
    expect(texts(renderer!)).toContain("Couldn't refresh your team");

    // A second refused refresh keeps them too, and the row still opens B.
    mockEnv.listBots.mockRejectedValueOnce(new Error('still refused'));
    mockEnv.openBot.mockResolvedValue(true);
    await pressLabel(renderer!, 'Tap to retry');
    expect(texts(renderer!)).toContain('beta-cached');

    await pressLabel(renderer!, 'Chat with beta-cached');
    expect(mockEnv.openBot).toHaveBeenCalledWith('beta-cached');
    expect(mockEnv.openBot).not.toHaveBeenCalledWith('alpha');
  });

  test('disconnecting drops the roster and a late A answer cannot bring it back', async () => {
    mockCache.set('roster:gate-a:bots', { value: [bot('alpha-cached')], savedAt: Date.now() });
    const aLive = deferred<PublicBot[]>();
    mockEnv.listBots.mockReturnValueOnce(aLive.promise);
    await mount();
    expect(chatRows(renderer!)).toEqual(['Chat with alpha-cached']);

    // The provider's disconnect clears the active gateway and goes down.
    await redraw({ activeGateway: null, gateways: [GATE_A], status: 'disconnected' });
    expect(texts(renderer!)).not.toContain('alpha-cached');
    expect(chatRows(renderer!)).toEqual([]);

    // The read that was in flight for A lands after the disconnect.
    await act(async () => {
      aLive.resolve([bot('alpha-live')]);
    });
    await settle();

    expect(texts(renderer!)).not.toContain('alpha-live');
    expect(chatRows(renderer!)).toEqual([]);
    expect(mockEnv.openBot).not.toHaveBeenCalled();
  });

  test('an open that resolves after the switch does not surface A under B', async () => {
    mockEnv.listBots.mockResolvedValueOnce([bot('alpha')]);
    await mount();
    const opening = deferred<boolean>();
    mockEnv.openBot.mockReturnValueOnce(opening.promise);
    const press = chatRow(renderer!, 'alpha').props.onPress as () => Promise<void>;
    let inFlight!: Promise<void>;
    await act(async () => {
      inFlight = press();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockEnv.openBot).toHaveBeenCalledWith('alpha');

    await redraw({ activeGateway: GATE_B, gateways: [GATE_A, GATE_B] });
    await act(async () => {
      opening.resolve(true);
      await inFlight;
    });
    await settle();

    expect(mockEnv.requestSurface).not.toHaveBeenCalled();
    expect(mockEnv.push).not.toHaveBeenCalled();
    expect(mockEnv.closeDrawer).not.toHaveBeenCalled();
    expect(texts(renderer!)).not.toContain('alpha');
    expect(chatRows(renderer!)).toEqual([]);
  });
});

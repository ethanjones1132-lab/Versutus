import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  drawerRosterReadDue,
  openTeammateChat,
  SideDrawerContent,
  DRAWER_ROSTER_OFFLINE_REVALIDATE_MS,
  DRAWER_ROSTER_STALE_MS,
} from '@/components/nav/side-drawer-content';
import type { PublicBot } from '@/lib/gateway/bots';

// The drawer content is mounted beside every screen, so its roster read is the
// most expensive read in the app by frequency: it used to fire on every
// `status` transition with no cache and a bare `.catch`, and it closed itself
// and navigated to a chat before the Bot had opened. These pin the shared,
// throttled read and the awaited tap.

// The drawer's own chrome is irrelevant to what is being decided here.
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

/**
 * The shared roster cache, standing in for the one the Chat roster writes.
 *
 * Keyed on the NAMESPACE too, so DRAWER-1's central claim is pinned rather than
 * assumed: a drawer that read `'rosters'` instead of `'roster'` would miss
 * every copy the Chat roster wrote, and the seeded entries below would be
 * invisible. `mockCacheReadGate` parks `readCached` behind a promise the test
 * releases, which is what a cold Android start looks like — AsyncStorage
 * opening its SQLite DB while the LAN `/v1/bots` call wins the race.
 */
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

function drawProps(gatewayPatch: Record<string, unknown> = {}) {
  mockEnv.gateway = { ...mockEnv.gateway, ...gatewayPatch };
  return {
    navigation: { closeDrawer: mockEnv.closeDrawer },
    state: {
      routes: [{ name: 'chat', key: `chat-${mockEnv.gateway.status}` }],
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

/** Re-render the SAME drawer with a new provider shape, as a status flip does. */
async function redraw(gatewayPatch: Record<string, unknown>) {
  await act(async () => {
    renderer?.update(createElement(SideDrawerContent, drawProps(gatewayPatch) as never));
  });
  await settle();
}

/** Let the microtask queue drain and let the effects that follow it come due. */
async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Move the wall clock the ledger is judged against. */
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
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

/** Press the first rendered row whose accessibility label matches. */
async function pressLabel(renderer: ReactTestRenderer, fragment: string) {
  const row = renderer.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
    .find((node) => node.props.accessibilityLabel.includes(fragment));
  if (!row) throw new Error(`no row labelled with "${fragment}"`);
  await act(async () => {
    await row.props.onPress();
  });
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  // The read ledger is judged against `Date.now()`, so the outage window only
  // means something against a clock this test controls.
  jest.useFakeTimers();
  mockCache = new Map();
  mockCacheReadGate = null;
  mockEnv = {
    push: jest.fn() as unknown as jest.Mock,
    listBots: jest.fn() as unknown as jest.Mock,
    openBot: jest.fn() as unknown as jest.Mock,
    requestSurface: jest.fn() as unknown as jest.Mock,
    clearBot: jest.fn() as unknown as jest.Mock,
    closeDrawer: jest.fn() as unknown as jest.Mock,
    gateway: {},
  };
  mockEnv.gateway = {
    status: 'connected',
    statusDetail: undefined,
    activeGateway: { id: 'gate-1', name: 'Studio' },
    gateways: [{ id: 'gate-1', name: 'Studio' }],
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

/** Remount the drawer from scratch — a fresh mount, refs and all. */
async function mount(patch: Record<string, unknown> = {}) {
  await act(async () => {
    renderer = drawDrawer(patch);
  });
  await settle();
}

describe('the drawer roster read', () => {
  test('the cached copy is on screen before its own read answers', async () => {
    mockCache.set('roster:gate-1:bots', { value: [bot('cached')], savedAt: Date.now() });
    mockEnv.listBots.mockReturnValue(new Promise<PublicBot[]>(() => undefined));

    await mount();

    expect(texts(renderer!)).toContain('cached');
    expect(texts(renderer!)).not.toContain("Couldn't refresh your team");
  });

  test('the drawer reads and writes the exact copy the Chat roster writes', async () => {
    // The whole point of DRAWER-1 is ONE copy of the roster, so the namespace
    // is the claim: `'roster'`, this gateway, `'bots'` — the same three
    // arguments chat-screen.tsx passes. A different namespace would leave the
    // drawer and the roster screen ageing two copies of the same list.
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();

    const store = jest.requireMock('@/lib/cache/swr-store') as {
      readCached: jest.Mock;
      writeCached: jest.Mock;
    };
    expect(store.readCached).toHaveBeenCalledWith('roster', 'gate-1', 'bots');
    expect(store.writeCached).toHaveBeenCalledWith('roster', 'gate-1', 'bots', [bot('forge')]);
  });

  test('a cached copy that lands after the live answer never paints over it', async () => {
    // Both reads start in the same commit. Here the Gate answers before this
    // device's cache does (a cold Android start: AsyncStorage opening its
    // SQLite DB while the LAN `/v1/bots` call wins). Painting the remembered
    // roster over the fresher live one is the race the roster screen guards
    // against with `rosterAnsweredRef`; the drawer did not, and there was no
    // interval to heal it.
    mockCache.set('roster:gate-1:bots', { value: [bot('cached')], savedAt: Date.now() });
    let openCache!: () => void;
    mockCacheReadGate = new Promise<void>((resolve) => {
      openCache = () => resolve();
    });
    mockEnv.listBots.mockResolvedValue([bot('forge')]);

    await mount();
    expect(texts(renderer!)).toContain('forge');

    // The cache finally answers, with the older roster.
    await act(async () => {
      openCache();
    });
    await settle();

    expect(texts(renderer!)).toContain('forge');
    expect(texts(renderer!)).not.toContain('cached');
  });

  test('a live read that refuses still lets the remembered roster paint', async () => {
    // The mirror of the guard above: a FAILED live read is not an answer, so
    // the last-known-good copy beside the error is the whole point of painting
    // one first.
    mockCache.set('roster:gate-1:bots', { value: [bot('cached')], savedAt: Date.now() });
    let openCache!: () => void;
    mockCacheReadGate = new Promise<void>((resolve) => {
      openCache = () => resolve();
    });
    mockEnv.listBots.mockRejectedValue(new Error('roster refused'));

    await mount();
    await act(async () => {
      openCache();
    });
    await settle();

    expect(texts(renderer!)).toContain('cached');
  });

  test('a status flip inside the stale window adds no second read', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();
    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);

    // The monitor self-heal: connected -> reconnecting -> connected a second
    // later. This used to add a roster read on every one of those transitions.
    await redraw({ status: 'reconnecting' });
    await advance(1_000);
    await redraw({ status: 'connected' });

    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);
  });

  test('an outage longer than 10s is news, and gets one read', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();
    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);

    // The connection is gone for a minute: the roster may have moved while it
    // was away, so the return to `connected` owes one read.
    await redraw({ status: 'disconnected' });
    await advance(60_000);
    await redraw({ status: 'connected' });
    expect(mockEnv.listBots).toHaveBeenCalledTimes(2);

    // A self-heal right after it is not: the stamp was consumed by the read.
    await redraw({ status: 'reconnecting' });
    await advance(1_000);
    await redraw({ status: 'connected' });
    expect(mockEnv.listBots).toHaveBeenCalledTimes(2);
  });

  test('a cache older than the stale window gets re-read once it is connected', async () => {
    mockCache.set('roster:gate-1:bots', { value: [bot('cached')], savedAt: Date.now() - 60_000 });
    mockEnv.listBots.mockResolvedValue([bot('forge')]);

    await mount();
    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);
    expect(texts(renderer!)).toContain('forge');
  });

  test('a refused read keeps the rows and says the list could not be refreshed', async () => {
    mockCache.set('roster:gate-1:bots', { value: [bot('cached')], savedAt: Date.now() });
    mockEnv.listBots.mockRejectedValue(new Error('roster refused'));

    await mount();

    // The list the operator was looking at is still there...
    expect(texts(renderer!)).toContain('cached');
    // ...and the drawer admits it is out of date, with a way forward.
    expect(texts(renderer!)).toContain("Couldn't refresh your team");
    expect(texts(renderer!)).toContain('tap to retry');
  });

  test('a first read that never succeeds still leaves a line on screen', async () => {
    // No cached copy, and the Gate refuses: the "Your team" block used to be
    // absent entirely, so there was nothing to say and nothing to retry.
    mockEnv.listBots.mockRejectedValue(new Error('roster refused'));
    await mount();

    expect(texts(renderer!)).toContain('Your team');
    expect(texts(renderer!)).toContain("Couldn't refresh your team");
  });

  test('tapping retry clears the line and reads again', async () => {
    mockEnv.listBots.mockRejectedValueOnce(new Error('roster refused'));
    await mount();
    expect(texts(renderer!)).toContain("Couldn't refresh your team");

    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await pressLabel(renderer!, 'Tap to retry');
    await settle();

    expect(texts(renderer!)).toContain('forge');
    expect(texts(renderer!)).not.toContain("Couldn't refresh your team");
  });

  test('a successful read is the copy the next mount paints from', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();

    // A fresh mount with the network refusing paints what the last read found.
    mockEnv.listBots.mockRejectedValue(new Error('roster refused'));
    await act(async () => {
      renderer?.unmount();
    });
    await mount();

    expect(texts(renderer!)).toContain('forge');
  });

  test('nothing is read while the connection is down', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    await mount();
    await redraw({ status: 'disconnected' });
    await advance(60_000);

    expect(mockEnv.listBots).toHaveBeenCalledTimes(1);
  });
});

describe('drawerRosterReadDue', () => {
  const base = {
    status: 'connected' as const,
    gatewayId: 'gate-1',
    lastRead: { gatewayId: 'gate-1', at: 1_000 },
    offlineSinceAt: null,
    cachedSavedAt: 1_000,
    now: 2_000,
  };

  test('disconnected, or no gateway, is never a read', () => {
    expect(drawerRosterReadDue({ ...base, status: 'disconnected' })).toBe(false);
    expect(drawerRosterReadDue({ ...base, gatewayId: null })).toBe(false);
  });

  test('a gateway never read for, and a gateway that changed, both read', () => {
    expect(drawerRosterReadDue({ ...base, lastRead: null })).toBe(true);
    expect(drawerRosterReadDue({ ...base, lastRead: { gatewayId: 'other', at: 1_000 } })).toBe(true);
  });

  test('a self-heal inside the window reads nothing', () => {
    expect(drawerRosterReadDue({ ...base, offlineSinceAt: 1_500 })).toBe(false);
  });

  test('an outage past 10s is news and reads once', () => {
    const offlineSinceAt = base.now - DRAWER_ROSTER_OFFLINE_REVALIDATE_MS;
    expect(drawerRosterReadDue({ ...base, offlineSinceAt })).toBe(true);
    expect(drawerRosterReadDue({ ...base, offlineSinceAt: offlineSinceAt + 1 })).toBe(false);
  });

  test('the cached copy decides while the connection held', () => {
    const fresh = { ...base, cachedSavedAt: base.now - DRAWER_ROSTER_STALE_MS + 1 };
    expect(drawerRosterReadDue(fresh)).toBe(false);
    expect(drawerRosterReadDue({ ...fresh, cachedSavedAt: base.now - DRAWER_ROSTER_STALE_MS })).toBe(true);
    // Nothing cached to age, so the Gate has to be asked.
    expect(drawerRosterReadDue({ ...fresh, cachedSavedAt: null })).toBe(true);
  });
});

describe('openTeammateChat', () => {
  const forge = { id: 'forge', displayName: 'Forge' };

  test('the Bot is opened, then the chat is asked for', async () => {
    const order: string[] = [];
    const outcome = await openTeammateChat(
      forge,
      async () => {
        order.push('open');
        return true;
      },
      () => order.push('surface'),
    );

    expect(outcome).toEqual({ ok: true });
    // Awaits first: closing the drawer and pushing `/chat` before this
    // answered left a failed tap on the previous Bot's chat.
    expect(order).toEqual(['open', 'surface']);
  });

  test('a refused open keeps the surface where it was, and says which Bot', async () => {
    let asked = false;
    const outcome = await openTeammateChat(
      forge,
      async () => false,
      () => {
        asked = true;
      },
    );

    expect(outcome).toEqual({ ok: false, reason: "Couldn't open Forge." });
    expect(asked).toBe(false);
  });

  test('a thrown open is caught here, never left for the drawer to discard', async () => {
    const outcome = await openTeammateChat(forge, async () => {
      throw new Error('no bots on this gate');
    }, () => undefined);

    expect(outcome.ok).toBe(false);
  });

  test('a surface request that throws is not reported as a failed open', async () => {
    // The try wraps the OPEN only. `requestSurface` is provider state the Chat
    // screen consumes later; if it threw, the Bot was already opened and the
    // session already switched, so reporting "Couldn't open Forge." would be
    // telling the operator the opposite of what happened.
    let asked: string | null = null;
    const outcome = openTeammateChat(
      forge,
      async () => true,
      () => {
        asked = 'forge';
        throw new Error('surface consumer is gone');
      },
    );

    await expect(outcome).rejects.toThrow('surface consumer is gone');
    expect(asked).toBe('forge');
  });
});

describe('tapping a teammate', () => {
  test('a Bot that opens closes the drawer and goes to the chat', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    mockEnv.openBot.mockResolvedValue(true);
    await mount();

    await pressLabel(renderer!, 'Chat with forge');
    await settle();

    expect(mockEnv.closeDrawer).toHaveBeenCalledTimes(1);
    expect(mockEnv.push).toHaveBeenCalledWith('/chat');
    expect(mockEnv.requestSurface).toHaveBeenCalledWith({ kind: 'bot', botId: 'forge' });
  });

  test('a Bot that will not open leaves the operator where they were', async () => {
    mockEnv.listBots.mockResolvedValue([bot('forge')]);
    mockEnv.openBot.mockRejectedValue(new Error('bots unavailable'));
    await mount();

    await pressLabel(renderer!, 'Chat with forge');
    await settle();

    expect(mockEnv.closeDrawer).not.toHaveBeenCalled();
    expect(mockEnv.push).not.toHaveBeenCalled();
    expect(texts(renderer!)).toContain("Couldn't open forge.");
  });
});

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SideDrawerContent } from '@/components/nav/side-drawer-content';
import type { PublicBot } from '@/lib/gateway/bots';
import type { ActivityRun } from '@/lib/gateway/runs';

// DRW-1/2/3: the drawer is mounted beside every screen for the life of the app,
// so every node below it was rebuilt on an OPEN_DRAWER and on every gateway
// update — two gradient canvases, the brand mark, three nav rows, up to six SVG
// avatars and the pulsing Gate footer, all of it landing while the slide
// animation is supposed to be starting. These count what actually renders, and
// pin the tree those renders produce so nothing about the drawer's look, its
// labels or its order can move while the wasted work goes.

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
// The real `router` singleton is module-level and never changes identity; a
// fresh object per call would make every `useCallback` in the drawer look
// unstable and hide what these tests are about.
jest.mock('expo-router', () => ({ useRouter: () => mockEnv.router }));
jest.mock('expo-router/drawer', () => ({ DrawerContentScrollView: 'DrawerContentScrollView' }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
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
jest.mock('@/lib/cache/swr-store', () => ({
  readCached: jest.fn(async () => null),
  writeCached: jest.fn(async () => undefined),
}));

type Renders = { avatar: number; avatarByBot: Record<string, number>; light: number; dot: number };

/**
 * One Bot's avatar — the SVG figure the drawer draws per teammate — counted per
 * Bot so a presence change can be asked to move ONE row rather than all of them.
 */
jest.mock('@/components/chat/bot-avatar', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return {
    BotAvatar: ({ botId, name, size }: { botId: string; name?: string; size?: number }) => {
      mockRenders.avatar += 1;
      mockRenders.avatarByBot[botId] = (mockRenders.avatarByBot[botId] ?? 0) + 1;
      return react.createElement('BotAvatar', { botId, name, size });
    },
  };
});

/**
 * The drawer's light, counted through the one node only it draws: a radial
 * gradient. `DrawerLight` takes no props, so nothing about the navigator, the
 * gateway or the roster can legitimately change it.
 */
jest.mock('react-native-svg', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  const counted = (name: string) => {
    const Node = ({ children, ...props }: { children?: unknown }) => {
      if (name === 'RadialGradient') mockRenders.light += 1;
      return react.createElement(name, props, children as never);
    };
    return Node;
  };
  return {
    __esModule: true,
    default: counted('Svg'),
    Circle: counted('Circle'),
    Defs: counted('Defs'),
    LinearGradient: counted('LinearGradient'),
    Path: counted('Path'),
    RadialGradient: counted('RadialGradient'),
    Rect: counted('Rect'),
    Stop: counted('Stop'),
  };
});

/** The Gate footer's dot — the one node only the footer draws. */
jest.mock('@/components/connection-badge', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  const actual = jest.requireActual('@/components/connection-badge') as Record<string, unknown>;
  return {
    ...actual,
    PulsingDot: ({ color, active }: { color: string; active: boolean }) => {
      mockRenders.dot += 1;
      return react.createElement('PulsingDot', { color, active });
    },
  };
});

let mockRenders: Renders;
let mockEnv: {
  router: { push: (...args: unknown[]) => void };
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

function run(id: string, botId: string | undefined, status: ActivityRun['status']): ActivityRun {
  return { id, botId, status, prompt: id, startedAt: 0, events: [] };
}

const TEAM = [bot('forge'), bot('ledger')];

type StatePatch = { routes?: { name: string }[]; index?: number; history?: string[]; status?: string };

function drawProps(gatewayPatch: Record<string, unknown> = {}, statePatch: StatePatch = {}) {
  mockEnv.gateway = { ...mockEnv.gateway, ...gatewayPatch };
  const routes = statePatch.routes ?? [{ name: 'chat' }];
  return {
    navigation: { closeDrawer: mockEnv.closeDrawer },
    state: {
      routes: routes.map((route) => ({ ...route, key: `${route.name}-key` })),
      index: statePatch.index ?? 0,
      key: 'drawer',
      routeNames: routes.map((route) => route.name),
      history: statePatch.history ?? ['chat'],
      status: statePatch.status ?? 'closed',
    },
    descriptors: {},
    route: { key: 'drawer' },
  };
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  mockRenders = { avatar: 0, avatarByBot: {}, light: 0, dot: 0 };
  mockEnv = {
    router: { push: (...args: unknown[]) => mockEnv.push(...args) },
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
    activityRunsForActiveGateway: [run('r1', 'forge', 'running')],
    sessionList: [],
  };
  mockEnv.listBots.mockResolvedValue(TEAM);
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

async function mount(gatewayPatch: Record<string, unknown> = {}, statePatch: StatePatch = {}) {
  await act(async () => {
    renderer = create(createElement(SideDrawerContent, drawProps(gatewayPatch, statePatch) as never));
  });
  await settle();
}

/** Re-render the same mounted drawer, as a state move or a provider update is. */
async function redraw(gatewayPatch: Record<string, unknown> = {}, statePatch: StatePatch = {}) {
  await act(async () => {
    renderer?.update(createElement(SideDrawerContent, drawProps(gatewayPatch, statePatch) as never));
  });
  await settle();
}

/** Everything the drawer put on screen, as one flat list of strings. */
function texts(root: ReactTestRenderer): string {
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
  walk(root.toJSON());
  return out.join(' | ');
}

function rowWith(root: ReactTestRenderer, label: string) {
  const row = root.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
    .filter((node) => node.props.accessibilityLabel === label || node.props.accessibilityLabel.startsWith(`${label},`));
  if (row.length === 0) throw new Error(`no row labelled "${label}"`);
  return row[row.length - 1];
}

/**
 * A stable text form of the rendered tree: every node's type, every prop that
 * is not a callback, and its children in order. Callbacks collapse to `fn`
 * because memoisation deliberately makes them different objects, and the
 * snapshot below is the DRAWER'S OUTPUT, not its wiring.
 */
function dump(node: unknown): string {
  if (typeof node === 'string') return JSON.stringify(node);
  if (node === null || node === undefined) return 'null';
  if (Array.isArray(node)) return `[${node.map(dump).join(',')}]`;
  const element = node as { type: unknown; props: Record<string, unknown>; children: unknown };
  const props = Object.keys(element.props)
    .sort()
    .map((key) => {
      const value = element.props[key];
      if (typeof value === 'function') return `${key}=fn`;
      if (key === 'style') return `${key}=${styleOf(value)}`;
      return `${key}=${JSON.stringify(value) ?? 'undefined'}`;
    })
    .join(' ');
  const children = Array.isArray(element.children)
    ? element.children.filter((child) => child !== null)
    : element.children;
  return `<${String(element.type)} ${props}>${dump(children)}</>`;
}

/** Styles as JSON, with the registered-StyleSheet numbers expanded if any. */
function styleOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(styleOf).join(',')}]`;
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * The tree as drawn, with React's `useId` tree ids folded together: the drawer
 * names its two gradients `pool-<id>` from `useId`, and that id counts mounts
 * rather than describing anything — it moves with the order tests run in, while
 * the gradient and the Rect that points at it stay in step either way.
 */
function treeDump(node: unknown): string {
  return dump(node).replace(/_r_[0-9a-z]+_/g, '_r_ID_');
}

describe('opening the drawer redraws nothing that did not change', () => {
  test('the gradients, the avatars and the footer survive an OPEN_DRAWER', async () => {
    await mount();
    const before = { ...mockRenders, avatarByBot: { ...mockRenders.avatarByBot } };
    // The roster is painted, so there is something below to spare.
    expect(before.avatar).toBe(2);
    expect(before.light).toBeGreaterThan(0);
    expect(before.dot).toBeGreaterThan(0);

    // Opening the drawer is a navigator state move and nothing else: the route
    // history grows and the drawer status flips, with the same gateway, the same
    // roster and the same runs behind it.
    await redraw(
      {},
      { history: ['chat', 'chat'], status: 'opened', routes: [{ name: 'chat' }], index: 0 },
    );

    expect(mockRenders.light).toBe(before.light);
    expect(mockRenders.avatar).toBe(before.avatar);
    expect(mockRenders.dot).toBe(before.dot);
    // ...and the drawer is still the same drawer.
    expect(texts(renderer!)).toContain('Your team');
    expect(texts(renderer!)).toContain('forge');
    expect(texts(renderer!)).toContain('ledger');
  });

  test('a gateway update that moves nothing on screen redraws nothing', async () => {
    await mount();
    const before = { ...mockRenders, avatarByBot: { ...mockRenders.avatarByBot } };

    // A new provider value: a session list arrived, a run event landed and a
    // second run of the same Bot's joined the list. Presence is unchanged.
    await redraw({
      sessionList: [{ id: 's1', title: 'Morning run' }],
      activityRunsForActiveGateway: [
        run('r1', 'forge', 'running'),
        run('r2', 'forge', 'complete'),
      ],
    });

    expect(mockRenders.light).toBe(before.light);
    expect(mockRenders.avatar).toBe(before.avatar);
    expect(texts(renderer!)).toContain('working');
  });

  test('a re-read that answers with the same roster repaints nothing', async () => {
    await mount();
    const before = { ...mockRenders.avatarByBot };

    // The roster read is throttled against the status ledger, so an outage is
    // what earns a second `/v1/bots`. The Gate answers with the list the drawer
    // is already showing — a fresh answer, but not new rows.
    await redraw({ status: 'disconnected' });
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await settle();
    await redraw({ status: 'connected' });

    expect(mockEnv.listBots).toHaveBeenCalledTimes(2);
    expect(mockRenders.avatarByBot.forge).toBe(before.forge);
    expect(mockRenders.avatarByBot.ledger).toBe(before.ledger);
    expect(texts(renderer!)).toContain('forge');
  });
});

describe('a change that IS visible still lands', () => {
  test('a presence change redraws the one teammate it is about', async () => {
    await mount();
    const before = { ...mockRenders.avatarByBot };
    // Both teammates are on screen: one paint each.
    expect(before.forge).toBe(before.ledger);
    expect(before.forge).toBeGreaterThan(0);

    // Forge moves from "working" to "needs you"; Ledger says nothing new.
    await redraw({
      activityRunsForActiveGateway: [run('r1', 'forge', 'waiting-approval')],
    });

    expect(mockRenders.avatarByBot.forge).toBe(before.forge + 1);
    expect(mockRenders.avatarByBot.ledger).toBe(before.ledger);
    expect(texts(renderer!)).toContain('needs you');
    // ...and the row's own label says so too, for the screen reader.
    expect(rowWith(renderer!, 'Chat with forge, needs you').props.accessibilityLabel).toBe(
      'Chat with forge, needs you',
    );
  });

  test('a connection change redraws the footer', async () => {
    await mount();
    const before = mockRenders.dot;

    await redraw({ status: 'reconnecting' });

    expect(mockRenders.dot).toBe(before + 1);
    expect(texts(renderer!)).toContain('Reconnecting');
  });

  test('a route change moves the selected row', async () => {
    await mount();
    expect((rowWith(renderer!, 'Activity').props.accessibilityState as { selected: boolean }).selected).toBe(
      false,
    );

    await redraw({}, { routes: [{ name: 'chat' }, { name: 'activity' }], index: 1 });

    expect((rowWith(renderer!, 'Activity').props.accessibilityState as { selected: boolean }).selected).toBe(
      true,
    );
    expect((rowWith(renderer!, 'Chats').props.accessibilityState as { selected: boolean }).selected).toBe(
      false,
    );
  });
});

describe('the drawer draws exactly what it drew before it was memoised', () => {
  test('the whole rendered tree, node for node and prop for prop', async () => {
    mockEnv.gateway = {
      ...mockEnv.gateway,
      pendingApprovals: [{ id: 'a1' }],
      activityRunsForActiveGateway: [run('r1', 'forge', 'waiting-approval'), run('r2', 'ledger', 'running')],
    };
    await mount();
    expect(treeDump(renderer!.toJSON())).toBe(
      `<View style=[{"flex":1,"backgroundColor":"#18181C"},{"paddingTop":24}]>[<View pointerEvents="none" style={"position":"absolute","left":0,"right":0,"top":0,"bottom":0}>[<Svg height=260 style={"position":"absolute","top":0,"left":0} width="100%">[<Defs >[<RadialGradient cx="18%" cy="4%" fx="18%" fy="4%" id="pool-_r_ID_" rx="75%" ry="80%">[<Stop offset="0" stopColor="#8B7CFF" stopOpacity=0.34>null</>,<Stop offset="0.5" stopColor="#6B5CF0" stopOpacity=0.1>null</>,<Stop offset="1" stopColor="#6B5CF0" stopOpacity=0>null</>]</>]</>,<Rect fill="url(#pool-_r_ID_)" height=260 width="100%">null</>]</>,<Svg height="100%" style={"position":"absolute","top":0,"right":0} width=1>[<Defs >[<LinearGradient id="edge-_r_ID_" x1="0" x2="0" y1="0" y2="1">[<Stop offset="0" stopColor="#FFFFFF" stopOpacity=0.14>null</>,<Stop offset="0.45" stopColor="#FFFFFF" stopOpacity=0.04>null</>,<Stop offset="1" stopColor="#FFFFFF" stopOpacity=0>null</>]</>]</>,<Rect fill="url(#edge-_r_ID_)" height="100%" width=1>null</>]</>]</>,<View style={"flexDirection":"row","alignItems":"center","gap":10,"paddingHorizontal":20,"paddingBottom":20}>[<Svg height=28 viewBox="0 0 76 76" width=28>[<Defs >[<LinearGradient gradientUnits="userSpaceOnUse" id="versutusMarkBg" x1="0" x2="76" y1="0" y2="76">[<Stop offset="0" stopColor="#8B7CFF">null</>,<Stop offset="1" stopColor="#6B5CF0">null</>]</>]</>,<Rect fill="url(#versutusMarkBg)" height=76 rx=18 width=76>null</>,<Path d="M22 26 L38 54 L54 26" fill="none" stroke="#F5F7FA" strokeLinecap="round" strokeLinejoin="round" strokeWidth=3.5>null</>,<Path d="M38 22 L38 30" fill="none" stroke="#F5F7FA" strokeLinecap="round" strokeWidth=2>null</>,<Circle cx=38 cy=18 fill="#F5F7FA" r=5>null</>,<Circle cx=38 cy=18 fill="#0A0A0B" r=2>null</>]</>,<Text style=[{"fontSize":32,"lineHeight":38,"fontWeight":"400","letterSpacing":-0.3,"fontFamily":"InstrumentSerif_400Regular"},{"color":"#F5F7FA"},false,{"fontSize":28,"lineHeight":32,"letterSpacing":-0.3}]>["Versutus"]</>]</>,<View accessibilityHint="Talk to any model, no Bot in between" accessibilityLabel="New chat" accessibilityRole="button" accessibilityState={} accessibilityValue={} accessible=true collapsable=false focusable=true onBlur=fn onClick=fn onFocus=fn onResponderGrant=fn onResponderMove=fn onResponderRelease=fn onResponderTerminate=fn onResponderTerminationRequest=fn onStartShouldSetResponder=fn style=[{},[{"flexDirection":"row","alignItems":"center","gap":10,"minHeight":44,"marginHorizontal":8,"marginBottom":20,"paddingHorizontal":14,"borderRadius":999,"borderTopWidth":0.5},{"backgroundColor":"#222228","borderTopColor":"rgba(255, 255, 255, 0.07)"}]]>[<ViewManagerAdapter_SymbolModule animated=false colors=[] name="square.and.pencil" size=17 style={"width":17,"height":17} tint=4294309882 tintColor="#F5F7FA" type="monochrome" weight=undefined>null</>,<Text style=[{"fontSize":15,"lineHeight":20,"fontWeight":"500","letterSpacing":-0.1,"fontFamily":"InstrumentSans_500Medium"},{"color":"#F5F7FA"},false,{"flex":1}]>["New chat"]</>]</>,<DrawerContentScrollView contentContainerStyle={"paddingHorizontal":8,"paddingTop":0,"gap":24} descriptors={} navigation={} route={"key":"drawer"} showsVerticalScrollIndicator=false state={"routes":[{"name":"chat","key":"chat-key"}],"index":0,"key":"drawer","routeNames":["chat"],"history":["chat"],"status":"closed"} style={"flex":1}>[<View style={"gap":2}>[<View accessibilityLabel="Chats" accessibilityRole="button" accessibilityState={"selected":true} accessibilityValue={} accessible=true collapsable=false focusable=true onBlur=fn onClick=fn onFocus=fn onResponderGrant=fn onResponderMove=fn onResponderRelease=fn onResponderTerminate=fn onResponderTerminationRequest=fn onStartShouldSetResponder=fn style=[{},[{"flexDirection":"row","alignItems":"center","gap":14,"minHeight":44,"paddingHorizontal":12,"borderRadius":10,"overflow":"hidden"},{"backgroundColor":"rgba(245, 247, 250, 0.07)"}]]>[<View pointerEvents="none" style=[{"position":"absolute","left":0,"top":11,"bottom":11,"width":3,"borderRadius":2},{"backgroundColor":"#8B7CFF"}]>null</>,<ViewManagerAdapter_SymbolModule animated=false colors=[] name="bubble.left.and.bubble.right" size=19 style={"width":19,"height":19} tint=4294309882 tintColor="#F5F7FA" type="monochrome" weight=undefined>null</>,<Text numberOfLines=1 style=[{"fontSize":15,"lineHeight":20,"fontWeight":"500","letterSpacing":-0.1,"fontFamily":"InstrumentSans_500Medium"},{"color":"#F5F7FA"},false,{"flex":1}]>["Chats"]</>]</>,<View accessibilityLabel="Activity, 1 waiting for you" accessibilityRole="button" accessibilityState={"selected":false} accessibilityValue={} accessible=true collapsable=false focusable=true onBlur=fn onClick=fn onFocus=fn onResponderGrant=fn onResponderMove=fn onResponderRelease=fn onResponderTerminate=fn onResponderTerminationRequest=fn onStartShouldSetResponder=fn style=[{},[{"flexDirection":"row","alignItems":"center","gap":14,"minHeight":44,"paddingHorizontal":12,"borderRadius":10,"overflow":"hidden"},null]]>[<ViewManagerAdapter_SymbolModule animated=false colors=[] name="bolt" size=19 style={"width":19,"height":19} tint=4288455599 tintColor="#9CA3AF" type="monochrome" weight=undefined>null</>,<Text numberOfLines=1 style=[{"fontSize":15,"lineHeight":20,"fontWeight":"500","letterSpacing":-0.1,"fontFamily":"InstrumentSans_500Medium"},{"color":"#9CA3AF"},false,{"flex":1}]>["Activity"]</>,<View style=[{"minWidth":20,"height":20,"paddingHorizontal":6,"borderRadius":10,"alignItems":"center","justifyContent":"center"},{"backgroundColor":"#D6B76A"}]>[<Text maxFontSizeMultiplier=1.3 style=[{"fontSize":11,"lineHeight":14,"fontWeight":"500","letterSpacing":0.4,"fontFamily":"InstrumentSans_500Medium"},{"color":"#F5F7FA"},false,[{"letterSpacing":0,"fontWeight":"700"},{"color":"#0A0A0B"}]]>["1"]</>]</>]</>,<View accessibilityLabel="Tools" accessibilityRole="button" accessibilityState={"selected":false} accessibilityValue={} accessible=true collapsable=false focusable=true onBlur=fn onClick=fn onFocus=fn onResponderGrant=fn onResponderMove=fn onResponderRelease=fn onResponderTerminate=fn onResponderTerminationRequest=fn onStartShouldSetResponder=fn style=[{},[{"flexDirection":"row","alignItems":"center","gap":14,"minHeight":44,"paddingHorizontal":12,"borderRadius":10,"overflow":"hidden"},null]]>[<ViewManagerAdapter_SymbolModule animated=false colors=[] name="terminal" size=19 style={"width":19,"height":19} tint=4288455599 tintColor="#9CA3AF" type="monochrome" weight=undefined>null</>,<Text numberOfLines=1 style=[{"fontSize":15,"lineHeight":20,"fontWeight":"500","letterSpacing":-0.1,"fontFamily":"InstrumentSans_500Medium"},{"color":"#9CA3AF"},false,{"flex":1}]>["Tools"]</>]</>]</>,<View style={"gap":2}>[<Text maxFontSizeMultiplier=1.3 style=[{"fontSize":12,"lineHeight":16,"fontWeight":"600","letterSpacing":0.2,"fontFamily":"InstrumentSans_600SemiBold"},{"color":"#8A8F98"},false,{"paddingHorizontal":12,"paddingBottom":4}]>["Your team"]</>,<View accessibilityLabel="Chat with forge, needs you" accessibilityRole="button" accessibilityState={"selected":false} accessibilityValue={} accessible=true collapsable=false focusable=true onBlur=fn onClick=fn onFocus=fn onResponderGrant=fn onResponderMove=fn onResponderRelease=fn onResponderTerminate=fn onResponderTerminationRequest=fn onStartShouldSetResponder=fn style=[{},[{"flexDirection":"row","alignItems":"center","gap":14,"minHeight":44,"paddingHorizontal":12,"borderRadius":10,"overflow":"hidden"},null]]>[<BotAvatar botId="forge" name="forge" size=26>null</>,<Text numberOfLines=1 style=[{"fontSize":15,"lineHeight":20,"fontWeight":"500","letterSpacing":-0.1,"fontFamily":"InstrumentSans_500Medium"},{"color":"#9CA3AF"},false,{"flex":1}]>["forge"]</>,<View style={"flexDirection":"row","alignItems":"center","gap":5}>[<View style=[{"width":5,"height":5,"borderRadius":3},{"backgroundColor":"#D6B76A"}]>null</>,<Text maxFontSizeMultiplier=1.3 style=[{"fontSize":11,"lineHeight":14,"fontWeight":"500","letterSpacing":0.4,"fontFamily":"InstrumentSans_500Medium"},{"color":"#F5F7FA"},false,{"color":"#D6B76A"}]>["needs you"]</>]</>]</>,<View accessibilityLabel="Chat with ledger, working" accessibilityRole="button" accessibilityState={"selected":false} accessibilityValue={} accessible=true collapsable=false focusable=true onBlur=fn onClick=fn onFocus=fn onResponderGrant=fn onResponderMove=fn onResponderRelease=fn onResponderTerminate=fn onResponderTerminationRequest=fn onStartShouldSetResponder=fn style=[{},[{"flexDirection":"row","alignItems":"center","gap":14,"minHeight":44,"paddingHorizontal":12,"borderRadius":10,"overflow":"hidden"},null]]>[<BotAvatar botId="ledger" name="ledger" size=26>null</>,<Text numberOfLines=1 style=[{"fontSize":15,"lineHeight":20,"fontWeight":"500","letterSpacing":-0.1,"fontFamily":"InstrumentSans_500Medium"},{"color":"#9CA3AF"},false,{"flex":1}]>["ledger"]</>,<View style={"flexDirection":"row","alignItems":"center","gap":5}>[<View style=[{"width":5,"height":5,"borderRadius":3},{"backgroundColor":"#8B7CFF"}]>null</>,<Text maxFontSizeMultiplier=1.3 style=[{"fontSize":11,"lineHeight":14,"fontWeight":"500","letterSpacing":0.4,"fontFamily":"InstrumentSans_500Medium"},{"color":"#F5F7FA"},false,{"color":"#8B7CFF"}]>["working"]</>]</>]</>]</>]</>,<View style=[{"paddingHorizontal":8,"paddingTop":8,"gap":8},{"paddingBottom":16}]>[<View accessibilityLabel="Settings" accessibilityRole="button" accessibilityState={"selected":false} accessibilityValue={} accessible=true collapsable=false focusable=true onBlur=fn onClick=fn onFocus=fn onResponderGrant=fn onResponderMove=fn onResponderRelease=fn onResponderTerminate=fn onResponderTerminationRequest=fn onStartShouldSetResponder=fn style=[{},[{"flexDirection":"row","alignItems":"center","gap":14,"minHeight":44,"paddingHorizontal":12,"borderRadius":10,"overflow":"hidden"},null]]>[<ViewManagerAdapter_SymbolModule animated=false colors=[] name="gearshape" size=19 style={"width":19,"height":19} tint=4288455599 tintColor="#9CA3AF" type="monochrome" weight=undefined>null</>,<Text numberOfLines=1 style=[{"fontSize":15,"lineHeight":20,"fontWeight":"500","letterSpacing":-0.1,"fontFamily":"InstrumentSans_500Medium"},{"color":"#9CA3AF"},false,{"flex":1}]>["Settings"]</>]</>,<View accessibilityLabel="Gate status: Connected. Studio. Open Gate details." accessibilityRole="button" accessibilityState={} accessibilityValue={} accessible=true collapsable=false focusable=true onBlur=fn onClick=fn onFocus=fn onResponderGrant=fn onResponderMove=fn onResponderRelease=fn onResponderTerminate=fn onResponderTerminationRequest=fn onStartShouldSetResponder=fn style=[{},[{"flexDirection":"row","alignItems":"center","gap":12,"paddingHorizontal":14,"paddingVertical":12,"borderRadius":14},{"backgroundColor":"#222228"}]]>[<PulsingDot active=false color="#63D7A6">null</>,<View style={"flex":1,"minWidth":0,"gap":1}>[<Text numberOfLines=1 style=[{"fontSize":15,"lineHeight":20,"fontWeight":"500","letterSpacing":-0.1,"fontFamily":"InstrumentSans_500Medium"},{"color":"#F5F7FA"},false,null]>["Studio"]</>,<Text maxFontSizeMultiplier=1.4 numberOfLines=1 style=[{"fontSize":13,"lineHeight":18,"fontWeight":"500","letterSpacing":0,"fontFamily":"InstrumentSans_500Medium"},{"color":"#9CA3AF"},false,null]>["Connected"]</>]</>,<ViewManagerAdapter_SymbolModule animated=false colors=[] name="chevron.right" size=14 style={"width":14,"height":14} tint=4287270808 tintColor="#8A8F98" type="monochrome" weight=undefined>null</>]</>]</>]</>`,
    );
  });
});
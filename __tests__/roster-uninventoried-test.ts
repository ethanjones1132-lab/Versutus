import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatRoster, type ChatRosterProps } from '@/components/chat/chat-roster';
import { EmptyState } from '@/components/ui';
import {
  botInventoryAvailable,
  hasBotInventory,
  publishBotInventoryAvailable,
  rosterEmptyView,
} from '@/lib/gateway/bots';

jest.mock('@/constants/tokens', () => ({
  Radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  Spacing: { one: 4, two: 8, three: 12, four: 16, five: 20 },
  FontFamily: { serif: 'serif', serifItalic: 'serif-italic', sans: 'sans' },
}));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#000',
    accentDeep: '#000',
    accentMuted: '#000',
    accentWarm: '#000',
    backgroundElevated: '#000',
    backgroundInset: '#000',
    backgroundRaised: '#000',
    border: '#000',
    statusConnected: '#0f0',
    statusConnecting: '#ff0',
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/components/chat/bot-avatar', () => ({
  BotAvatar: 'BotAvatar',
  GroupAvatar: 'GroupAvatar',
}));
jest.mock('@/components/connection-badge', () => ({
  PulsingDot: 'PulsingDot',
  statusColor: () => '#000',
}));
jest.mock('@/components/ui', () => ({
  Button: 'Button',
  EmptyState: 'EmptyState',
  Icon: 'Icon',
  PressableScale: 'PressableScale',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));
jest.mock('@/lib/haptics', () => ({ haptics: { impact: jest.fn() } }));

const NAVIGATION_ROW: ChatRosterProps['rows'][number] = { kind: 'configurable' };
const ONE_BOT: ChatRosterProps['rows'] = [
  NAVIGATION_ROW,
  { kind: 'bot', bot: { id: 'scout', displayName: 'Scout', routable: true } },
];

async function mount(props: Partial<ChatRosterProps>) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(ChatRoster, {
        rows: [NAVIGATION_ROW],
        connected: true,
        loading: false,
        onSelectConfigurable: jest.fn(),
        onSelectBot: jest.fn(),
        ...props,
      }),
    );
  });
  return renderer;
}

function emptyStateTitles(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType(EmptyState).map((node) => node.props.title as string);
}

function emptyStates(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(EmptyState);
}

afterEach(() => {
  // The verdict is module state, like the crest fleet's tones: a test that
  // published "cannot inventory" must not leak it into the next one.
  publishBotInventoryAvailable(true);
});

describe('whether the client can inventory at all is a fact of its own', () => {
  test('the verdict is the roster call itself, not the ability to create', () => {
    // A plain Hermes client attached without a manifest: chat works, the
    // roster call is simply absent.
    expect(hasBotInventory({ createBot: async () => undefined })).toBe(false);
    // The manifest client implements the call whenever its document advertises
    // a bots endpoint, which is what makes a real zero answerable.
    expect(hasBotInventory({ listBots: async () => [] })).toBe(true);
    expect(hasBotInventory(null)).toBe(false);
    expect(hasBotInventory(undefined)).toBe(false);
    expect(botInventoryAvailable()).toBe(true);
  });

  test('publishing a verdict is a no-op when it does not change', () => {
    publishBotInventoryAvailable(false);
    expect(botInventoryAvailable()).toBe(false);
    publishBotInventoryAvailable(false);
    expect(botInventoryAvailable()).toBe(false);
    publishBotInventoryAvailable(true);
    expect(botInventoryAvailable()).toBe(true);
  });
});

describe('rosterEmptyView keeps the real zero and names the non-answer', () => {
  test('a client that can inventory an empty host still claims an honest zero', () => {
    // The exact shape bots-roster-test.ts pins: an empty array is a believed
    // answer, so no flag may be invented for it.
    expect(
      rosterEmptyView({ totalBotRows: 0, visibleBotRows: 0, visibleGroups: 0, query: '' }),
    ).toEqual({ kind: 'zero-bots' });
    expect(
      rosterEmptyView({
        totalBotRows: 0,
        visibleBotRows: 0,
        visibleGroups: 0,
        query: '',
        inventoryAvailable: true,
      }),
    ).toEqual({ kind: 'zero-bots' });
  });

  test('an empty list from a client with no roster call is not a zero', () => {
    expect(
      rosterEmptyView({
        totalBotRows: 0,
        visibleBotRows: 0,
        visibleGroups: 0,
        query: '',
        inventoryAvailable: false,
      }),
    ).toEqual({ kind: 'uninventoried' });
  });

  test('a failing read still names itself rather than the missing capability', () => {
    expect(
      rosterEmptyView({
        totalBotRows: 0,
        visibleBotRows: 0,
        visibleGroups: 0,
        query: '',
        error: 'hermes: An internal server error has occurred',
        inventoryAvailable: false,
      }),
    ).toEqual({ kind: 'load-failed', reason: 'hermes: An internal server error has occurred' });
  });

  test('rows already on screen speak for themselves, capability or not', () => {
    expect(
      rosterEmptyView({
        totalBotRows: 2,
        visibleBotRows: 2,
        visibleGroups: 0,
        query: '',
        inventoryAvailable: false,
      }),
    ).toEqual({ kind: 'none' });
    expect(
      rosterEmptyView({
        totalBotRows: 2,
        visibleBotRows: 0,
        visibleGroups: 0,
        query: 'nomatch',
        inventoryAvailable: false,
      }),
    ).toEqual({ kind: 'no-match', query: 'nomatch' });
  });

  test('a caller that says nothing keeps every pre-existing answer', () => {
    // The other cases of the table, unchanged: no connection waits, a named
    // failure leads, and a blank query is never "no match".
    expect(
      rosterEmptyView({ totalBotRows: 0, visibleBotRows: 0, visibleGroups: 0, query: '', connected: false }),
    ).toEqual({ kind: 'waiting' });
    expect(
      rosterEmptyView({
        totalBotRows: 0,
        visibleBotRows: 0,
        visibleGroups: 0,
        query: '',
        error: 'gateway unreachable',
      }),
    ).toEqual({ kind: 'load-failed', reason: 'gateway unreachable' });
    expect(
      rosterEmptyView({ totalBotRows: 0, visibleBotRows: 0, visibleGroups: 0, query: '' }),
    ).not.toEqual({ kind: 'uninventoried' });
  });
});

describe('the roster surface shows the distinct line when the read never ran', () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(async () => {
    const current = renderer;
    renderer = undefined;
    if (current) await act(async () => { current.unmount(); });
  });

  test('a connected client with no roster call says it cannot inventory', async () => {
    publishBotInventoryAvailable(false);
    renderer = await mount({ connected: true, loading: false });
    expect(emptyStateTitles(renderer)).toEqual(["Can't inventory agents"]);
    expect(emptyStateTitles(renderer)).not.toContain('No bots on this gateway');
  });

  test('a real empty roster keeps the exact "No bots" copy', async () => {
    publishBotInventoryAvailable(true);
    renderer = await mount({ connected: true, loading: false });
    expect(emptyStateTitles(renderer)).toEqual(['No bots on this gateway']);
    expect(emptyStateTitles(renderer)).not.toContain("Can't inventory agents");
  });

  test('the verdict reaches a roster that is already on screen', async () => {
    // The client installs after the surface mounts, so the footer flips
    // without a remount: the store is subscribed, not read once.
    publishBotInventoryAvailable(true);
    renderer = await mount({ connected: true, loading: false });
    expect(emptyStateTitles(renderer)).toEqual(['No bots on this gateway']);
    await act(async () => {
      publishBotInventoryAvailable(false);
    });
    expect(emptyStateTitles(renderer)).toEqual(["Can't inventory agents"]);
  });

  test('the non-answer offers no Retry it could never honour', async () => {
    publishBotInventoryAvailable(false);
    renderer = await mount({ connected: true, loading: false, onRefresh: jest.fn() });
    const state = emptyStates(renderer)[0];
    expect(state.props.title).toBe("Can't inventory agents");
    expect(state.props.actionLabel).toBeUndefined();
    expect(state.props.onAction).toBeUndefined();
  });

  test('last-good rows are never replaced by the capability line', async () => {
    publishBotInventoryAvailable(false);
    renderer = await mount({ rows: ONE_BOT, connected: true, loading: false });
    expect(emptyStateTitles(renderer)).toEqual([]);
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('the verdict is wired from the client install to the footer', () => {
  test('the provider publishes the installed client verdict', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    // The install path is the only place a client becomes live, so it is the
    // one place the answer can be read from it.
    expect(src).toMatch(/publishBotInventoryAvailable\(probeBotInventory\(client\)\)/);
    // Every teardown that gives up a client also gives up its verdict: no
    // client means no evidence, so a disconnected roster waits instead of
    // claiming the connection could never inventory.
    const resets = src.match(/publishBotInventoryAvailable\(true\)/g) ?? [];
    expect(resets).toHaveLength(3);
  });

  test('the roster feeds that verdict into its empty-state decision', () => {
    const src = readSource('src', 'components', 'chat', 'chat-roster.tsx');
    const call = src.match(/rosterEmptyView\(\{[\s\S]*?\}\);/)?.[0];
    expect(call).toBeDefined();
    expect(call).toMatch(/inventoryAvailable,/);
    // Subscribed, so a verdict that arrives after mount still reaches the footer.
    expect(src).toMatch(/useSyncExternalStore\(\s*subscribeBotInventoryAvailable,\s*botInventoryAvailable,\s*botInventoryAvailable,?\s*\)/);
    // And only the distinct line is drawn from it — the zero-bots block above
    // is unchanged.
    expect(src).toMatch(/emptyView\.kind === 'uninventoried'/);
  });
});

// ─── Spend: a gateway switch shows this gateway's numbers, or none ──────────
//
// Two confirmed defects live on this screen. The total and the per-Bot rows
// were never cleared when `activeGateway` changed, and `loadSpend` only ever
// folded the new read into the previous state — so after switching from gateway
// A to B the hero total and the Bot rows kept A's numbers under B's name, and a
// failed read for B kept them there beside the error card. Separately the cap
// store answered `{}` for a store it could not read at all, so the screen
// marked it loaded and the first cap edit saved a one-entry map over every
// other Bot's cap.
//
// These drive the real screen: the assertions are about what is painted and
// what is written, never about the shape of the code.

// budgets.ts reaches storage through this module; the cap reads themselves are
// mocked below, but the module graph still loads the AsyncStorage edge.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

// The real budgets module's storage edge, stubbed so the unreadable-store case
// is the store refusing a read rather than a platform difference.
jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    getAllKeys: jest.fn(async () => []),
    multiRemove: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => true, back: jest.fn(), replace: jest.fn() }),
}));

// The screen's own primitives carry no behaviour under test here; the mocked
// components keep their props, which is how the painted total, rows, caps and
// causes are observed.
jest.mock('@/components/ui', () => ({
  Screen: 'Screen',
  Card: 'Card',
  EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  PageTitle: 'PageTitle',
  PressableScale: 'PressableScale',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));

jest.mock('@/components/gateway/spend-chart', () => ({ SpendChart: 'SpendChart' }));
jest.mock('@/components/gateway/spend-session-table', () => ({ SpendSessionTable: 'SpendSessionTable' }));
jest.mock('@/components/gateway/spend-per-bot-section', () => ({ SpendPerBotSection: 'SpendPerBotSection' }));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

// The real fold (setBotBudget, BUDGETS_UNREAD, budgetKey) with the two storage
// calls stubbed, so a cap's write can be counted and an unreadable store can be
// the exact value the real loader answers.
jest.mock('@/lib/gateway/budgets', () => ({
  ...jest.requireActual('@/lib/gateway/budgets'),
  loadBudgets: jest.fn(async () => ({})),
  saveBudgets: jest.fn(async () => undefined),
}));

import { createElement, type ElementType } from 'react';
import { ScrollView } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import GatewaySpendScreen from '@/app/gateway/spend';
import { BUDGETS_UNREAD, loadBudgets, saveBudgets } from '@/lib/gateway/budgets';
import type { SessionUsageInput } from '@/lib/gateway/session-analytics';
import type { BotSpendReport, SpendSessionRow } from '@/lib/gateway/spend-report';
import { keyValueStorage } from '@/lib/storage/key-value';

// React Native's first render in a process lazily loads its own internals
// (VirtualizedList and the cell renderer behind it): ~0.6 s against a warm
// transform cache, and on a loaded machine several times that — all of it
// charged to whichever test happens to render first. Nothing here is under
// test, and no test has a business paying it, so the screen's own container
// pays it once, here, at module scope, where no per-test clock is running.
act(() => {
  create(createElement(ScrollView)).unmount();
});

const CHART = 'SpendChart' as ElementType;
const CARD = 'Card' as ElementType;
const TABLE = 'SpendSessionTable' as ElementType;
const SECTION = 'SpendPerBotSection' as ElementType;
const ERROR = 'ErrorCard' as ElementType;

/** The real loader, for the store-level half of the budget contract. */
const realBudgets = jest.requireActual('@/lib/gateway/budgets') as typeof import('@/lib/gateway/budgets');
const storedItem = keyValueStorage.getItem as jest.Mock;

/** One sessions.list envelope with a single catalogued session. */
function catalogued(id: string): { object: string; data: SessionUsageInput[] } {
  return {
    object: 'list',
    data: [{ id, input_tokens: 10, actual_cost_usd: 0.5 }],
  };
}

/**
 * The provider the screen reads, mutable so a re-render can move the gateway.
 * `request` answers `sessions.list`; a test that wants an answer to land later
 * hands out deferreds instead.
 */
const mockGateway = {
  status: 'connected' as string,
  gatewayId: 'gw-1',
  request: jest.fn(),
  listBots: jest.fn(),
  readBotSessions: jest.fn(),
};

const roster: { id: string; displayName: string }[] = [];

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** A queue of `sessions.list` answers, so the test decides when one lands. */
function readQueue() {
  const pending: Pending[] = [];
  const request = jest.fn(() => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending.push({ resolve, reject });
    return promise;
  });
  return { request, pending };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

beforeEach(() => {
  jest.clearAllMocks();
  roster.length = 0;
  mockGateway.status = 'connected';
  mockGateway.gatewayId = 'gw-1';
  mockGateway.request = jest.fn(async () => catalogued('s-default'));
  mockGateway.listBots = jest.fn(async () => roster.map((bot) => ({ ...bot })));
  mockGateway.readBotSessions = jest.fn(async (botId: string) => catalogued(`s-${botId}`));
  (loadBudgets as jest.Mock).mockResolvedValue({});
  storedItem.mockReset();
  storedItem.mockResolvedValue(null);
});

// The provider's callbacks are useCallback-stable in the real provider, so
// these are stable too: a fresh identity per render would re-run the read
// effect forever and mask the switch under test.
jest.mock('@/context/gateway-provider', () => {
  const gatewayRequest = (method: string, params?: unknown) => mockGateway.request(method, params);
  const listBots = async () => mockGateway.listBots();
  const readBotSessions = async (botId: string, limit: number, signal?: AbortSignal) =>
    mockGateway.readBotSessions(botId, limit, signal);
  const retryAutoConnect = async () => undefined;
  return {
    useGateway: () => ({
      status: mockGateway.status,
      gatewayRequest,
      listBots,
      readBotSessions,
      canReadBotSessions: true,
      activeGateway: { id: mockGateway.gatewayId, url: 'http://gate.test' },
      retryAutoConnect,
    }),
  };
});

let renderer: ReactTestRenderer | undefined;

/** Let every pending promise and its state writes land. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(GatewaySpendScreen));
  });
  await flush();
}

/** A re-render with whatever the provider now answers (a new gateway, say). */
async function rerender(): Promise<void> {
  await act(async () => {
    renderer?.update(createElement(GatewaySpendScreen));
  });
  await flush();
}

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined;
    await act(async () => {
      doomed.unmount();
    });
  }
});

function heroCount(): number {
  return (
    renderer?.root.findAll((node) => node.type === CARD && node.props.variant === 'hero').length ?? 0
  );
}

function chartShown(): boolean {
  return (renderer?.root.findAllByType(CHART).length ?? 0) > 0;
}

function sessionRows(): SpendSessionRow[] {
  return (renderer?.root.findAllByType(TABLE)[0]?.props.rows as SpendSessionRow[] | undefined) ?? [];
}

function sectionReport(): BotSpendReport | null {
  const section = renderer?.root.findAllByType(SECTION)[0];
  return (section?.props.report as BotSpendReport | undefined) ?? null;
}

function errorCauses(): string[] {
  return (renderer?.root.findAllByType(ERROR) ?? []).map((node) => String(node.props.cause));
}

/** Everything the page actually paints, as text. */
function painted(): string {
  function text(node: unknown): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    if (node && typeof node === 'object' && 'children' in node) return text(node.children);
    return '';
  }
  return text(renderer?.toJSON());
}

function setBudget(botId: string, cap: number | undefined): void {
  const section = renderer?.root.findAllByType(SECTION)[0];
  expect(section).toBeDefined();
  const onSetBudget = section?.props.onSetBudget as
    | ((bot: string, value: number | undefined) => void)
    | undefined;
  expect(onSetBudget).toBeDefined();
  onSetBudget?.(botId, cap);
}

function budgetsNotice() {
  return (renderer?.root.findAllByType(ERROR) ?? []).find((node) =>
    /budget caps/i.test(String(node.props.cause)),
  );
}

describe('a gateway switch never paints the previous gateway numbers', () => {
  test('the total, the chart and the session rows clear before the new answer lands', async () => {
    const { request, pending } = readQueue();
    mockGateway.request = request;
    roster.push({ id: 'a1', displayName: 'A1' });

    await mount();
    pending[0].resolve(catalogued('s-a1'));
    await flush();

    // Gateway A, read landed: the hero total, the chart, A's session row and
    // A's Bot row are all on screen.
    expect(heroCount()).toBe(1);
    expect(chartShown()).toBe(true);
    expect(sessionRows().map((row) => row.key)).toEqual(['s-a1']);
    expect(painted()).toContain('Cost: $0.50');
    expect(sectionReport()?.rows.map((row) => row.botId)).toEqual(['a1']);

    // The switch: gateway B's catalogue read is on the wire and unanswered, and
    // B's roster is not going to land either.
    mockGateway.gatewayId = 'gw-2';
    mockGateway.listBots = jest.fn(() => never<{ id: string }[]>());
    await rerender();

    // Nothing of A's may stand under B's name while B is being read.
    expect(request).toHaveBeenCalledTimes(2);
    expect(heroCount()).toBe(0);
    expect(chartShown()).toBe(false);
    expect(sessionRows()).toEqual([]);
    expect(sectionReport()).toBeNull();
    expect(painted()).not.toContain('Cost: $0.50');
    expect(painted()).not.toContain('A1');
  });

  test('a failed read for the new gateway shows its own error and no old total', async () => {
    const { request, pending } = readQueue();
    mockGateway.request = request;
    roster.push({ id: 'a1', displayName: 'A1' });

    await mount();
    pending[0].resolve(catalogued('s-a1'));
    await flush();
    expect(painted()).toContain('Cost: $0.50');

    mockGateway.gatewayId = 'gw-2';
    await rerender();
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1].reject(new Error('gateway B is unreachable'));
    });
    await flush();

    // B's refusal is named with its own cause, and the empty first read means
    // there is nothing retained to show beside it — A's total is never reused.
    expect(errorCauses()).toContain('gateway B is unreachable');
    expect(heroCount()).toBe(0);
    expect(chartShown()).toBe(false);
    expect(sessionRows()).toEqual([]);
    expect(painted()).not.toContain('Cost: $0.50');
  });

  test('the per-Bot rows clear on the switch and a failed roster read does not restore them', async () => {
    roster.push({ id: 'a1', displayName: 'A1' });
    await mount();
    expect(sectionReport()?.rows.map((row) => row.botId)).toEqual(['a1']);

    // Gateway B's roster read is in flight and unanswered for now.
    let rejectRoster!: (error: unknown) => void;
    mockGateway.gatewayId = 'gw-2';
    mockGateway.listBots = jest.fn(
      () =>
        new Promise<{ id: string }[]>((_resolve, reject) => {
          rejectRoster = reject;
        }),
    );
    await rerender();

    expect(sectionReport()).toBeNull();
    expect(painted()).not.toContain('A1');

    await act(async () => {
      rejectRoster(new Error('gateway B went quiet'));
    });
    await flush();

    // Withdrawn, not resurrected: the section claims nothing about a gateway
    // whose roster it could not read.
    expect(sectionReport()).toBeNull();
    expect(painted()).not.toContain('A1');
  });

  test('a late retry for the previous gateway cannot replace the new gateway answer', async () => {
    const { request, pending } = readQueue();
    mockGateway.request = request;
    await mount();
    pending[0].reject(new Error('retry gateway A'));
    await flush();
    const retry = renderer?.root.findAllByType(ERROR).find((node) => node.props.cause === 'retry gateway A');
    await act(async () => { retry?.props.onRetry(); });
    expect(pending).toHaveLength(2);

    mockGateway.gatewayId = 'gw-2';
    await rerender();
    pending[2].resolve(catalogued('s-b'));
    await flush();
    expect(sessionRows().map((item) => item.key)).toEqual(['s-b']);

    pending[1].resolve(catalogued('s-a-late'));
    await flush();
    expect(sessionRows().map((item) => item.key)).toEqual(['s-b']);
    expect(heroCount()).toBe(1);
  });
});

describe('an unreadable cap store is never written over', () => {
  beforeEach(() => {
    roster.push({ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' });
  });

  test('a failed read leaves every cap unwritable, names it, and saves nothing', async () => {
    (loadBudgets as jest.Mock).mockResolvedValue(BUDGETS_UNREAD);

    await mount();

    // One cap set over caps this device never saw would delete every other
    // Bot's, so the editor is silent and the failure is on screen instead.
    expect(budgetsNotice()).toBeDefined();
    await act(async () => {
      // The section is still offered, so this is the real edit path.
      setBudget('b', 7);
    });
    await flush();

    expect(saveBudgets).not.toHaveBeenCalled();
  });

  test('once a read succeeds the first cap set keeps every other Bot cap', async () => {
    (loadBudgets as jest.Mock).mockResolvedValue(BUDGETS_UNREAD);

    await mount();
    const notice = budgetsNotice();
    expect(notice).toBeDefined();

    (loadBudgets as jest.Mock).mockResolvedValue({ 'gw-1:b': 7 });
    await act(async () => {
      (notice?.props.onRetry as (() => void) | undefined)?.();
    });
    await flush();

    // The value just read back is not written straight back.
    expect(budgetsNotice()).toBeUndefined();
    expect(saveBudgets).not.toHaveBeenCalled();

    await act(async () => {
      setBudget('a', 5);
    });
    await flush();

    expect(saveBudgets).toHaveBeenCalledTimes(1);
    expect(saveBudgets).toHaveBeenCalledWith({ 'gw-1:b': 7, 'gw-1:a': 5 });
  });
});

describe('the loader reports an unreadable store separately from an empty one', () => {
  test.each(['', '{broken'])('an unparseable stored blob %p is unread, not an absent cap map', async (raw) => {
    storedItem.mockResolvedValueOnce(raw);
    expect(await realBudgets.loadBudgets()).toBe(BUDGETS_UNREAD);
  });

  test('a refused read answers BUDGETS_UNREAD; a store with no blob answers a plain empty map', async () => {
    storedItem.mockRejectedValueOnce(new Error('offline'));
    expect(await realBudgets.loadBudgets()).toBe(BUDGETS_UNREAD);

    const empty = await realBudgets.loadBudgets();
    expect(empty).toEqual({});
    expect(empty).not.toBe(BUDGETS_UNREAD);
  });
});

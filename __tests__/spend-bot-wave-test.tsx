// ─── Spend: one per-Bot fan-out per visit, and a wave you can walk away from ──
// The per-Bot section is a roster fan-out: `listBots()` plus one scoped
// `sessions.list` per Bot, two at a time, each with its own retry ladder. The
// effect that started it was keyed on `status`, which flips on every
// connection-monitor self-heal as well as on every real connect — so each
// transition restarted the whole roster while the previous wave was still
// running against a single-threaded, state.db-bound Gate. Its cleanup set a
// boolean and passed no signal, so leaving the screen mid-read left the app
// issuing Bot reads nobody was waiting for.
//
// These drive the real screen with a real `readBotSpend` and a deferred roster:
// the assertions are about how many requests are issued and when, which is the
// only thing the wave ledger is responsible for.

// budgets.ts reaches storage through this module; the caps themselves are
// mocked below, but the module graph still loads the real edge.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => true, back: jest.fn(), replace: jest.fn() }),
}));

// The screen's own primitives carry no behaviour under test here; the mocked
// components keep their props, which is how the wave's report and the cap
// store's callback are observed.
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

// The real fold (setBotBudget, budgetKey) with the storage edge stubbed, so a
// cap's write can be counted without AsyncStorage.
jest.mock('@/lib/gateway/budgets', () => ({
  ...jest.requireActual('@/lib/gateway/budgets'),
  loadBudgets: jest.fn(async () => ({})),
  saveBudgets: jest.fn(async () => undefined),
}));

import { createElement, type ElementType } from 'react';
import { ScrollView } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import GatewaySpendScreen from '@/app/gateway/spend';
import { loadBudgets, saveBudgets } from '@/lib/gateway/budgets';
import type { BotSpendReport } from '@/lib/gateway/spend-report';
import type { SessionUsageInput } from '@/lib/gateway/session-analytics';

// React Native's first render in a process lazily loads its own internals
// (VirtualizedList and the cell renderer behind it): ~0.6 s against a warm
// transform cache, and on a loaded machine several times that — all of it
// charged to whichever test happens to render first. That is how this suite's
// first test came to exceed the 20 s budget while the eight after it took 10 ms
// each. Nothing here is under test, and no test has a business paying it, so
// the screen's own container pays it once, here, at module scope, where no
// per-test clock is running.
act(() => {
  create(createElement(ScrollView)).unmount();
});

const SECTION = 'SpendPerBotSection' as ElementType;

type Deferred = { resolve: (value: unknown) => void };

function deferred(): Deferred & { promise: Promise<unknown> } {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function catalogued(id: string): SessionUsageInput[] {
  return [{ id: `s-${id}`, input_tokens: 10, actual_cost_usd: 0.5 } as unknown as SessionUsageInput];
}

/** The provider the screen reads, mutable so a re-render can move `status`. */
const mockGateway = {
  status: 'connected' as string,
  gatewayId: 'gw-1',
  listBots: jest.fn(),
  readBotSessions: jest.fn(),
};

const roster: { id: string; displayName: string }[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  roster.length = 0;
  mockGateway.status = 'connected';
  mockGateway.gatewayId = 'gw-1';
  mockGateway.listBots = jest.fn(async () => roster.map((bot) => ({ ...bot })));
  mockGateway.readBotSessions = jest.fn(async (botId: string) => catalogued(botId));
  (loadBudgets as jest.Mock).mockResolvedValue({});
});

// The provider's callbacks are useCallback-stable in the real provider, so
// these are stable too: a fresh identity per render would be a second defect
// (an effect keyed on it would re-run forever) and would mask the one under
// test.
jest.mock('@/context/gateway-provider', () => {
  const gatewayRequest = async () => ({ object: 'list', data: [] });
  const listBots = async () => mockGateway.listBots();
  // The provider forwards the third argument verbatim; dropping it here would
  // make every signal assertion below pass against a screen that never sends
  // one.
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
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(GatewaySpendScreen));
  });
  await flush();
}

async function show(status: string, gatewayId?: string): Promise<void> {
  mockGateway.status = status;
  if (gatewayId) mockGateway.gatewayId = gatewayId;
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

function sectionReport(): BotSpendReport | null {
  const section = renderer?.root.findAllByType(SECTION)[0];
  return (section?.props.report as BotSpendReport | undefined) ?? null;
}

describe('the per-Bot fan-out runs once per visit, not once per status transition', () => {
  test('a status flap inside the freshness window starts no second wave', async () => {
    roster.push({ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' });
    await mount();
    expect(mockGateway.listBots).toHaveBeenCalledTimes(1);
    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(2);

    // The monitor self-heal: connected -> reconnecting -> connected, with the
    // completed wave seconds old. Under the old deps this started a second
    // roster read on the way back.
    await show('reconnecting');
    await show('connected');

    expect(mockGateway.listBots).toHaveBeenCalledTimes(1);
    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(2);
  });

  test('a wave already in flight is not started again by a flap', async () => {
    roster.push({ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' });
    const pending = new Map<string, Deferred>();
    mockGateway.readBotSessions = jest.fn((botId: string) => {
      const gate = deferred();
      pending.set(botId, gate);
      return gate.promise;
    });

    await mount();
    await show('reconnecting');
    await show('connected');

    // One wave, two lanes: a second would show four outstanding reads.
    expect(mockGateway.listBots).toHaveBeenCalledTimes(1);
    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(2);
    for (const gate of pending.values()) gate.resolve(catalogued('a'));
    await flush();
  });

  test('a reconnect after the freshness window does earn a fresh wave', async () => {
    roster.push({ id: 'a', displayName: 'A' });
    await mount();
    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(1);

    // The freshness claim is about elapsed time, so the clock is the only thing
    // under test here — Date.now drives it directly.
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(Date.now() + 61_000);
    await show('reconnecting');
    await show('connected');
    now.mockRestore();

    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(2);
  });

  test('a different gateway starts its own wave rather than inheriting the last one', async () => {
    roster.push({ id: 'a', displayName: 'A' });
    await mount();
    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(1);

    await show('connected', 'gw-2');

    // Caps and rows are per gateway, so the previous PC's completed wave is no
    // evidence about this one.
    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(2);
  });
});

describe('the wave can be walked away from', () => {
  test('the lanes are handed the very signal the walk-away cancels on', async () => {
    roster.push(
      { id: 'a', displayName: 'A' },
      { id: 'b', displayName: 'B' },
      { id: 'c', displayName: 'C' },
    );
    const pending = new Map<string, Deferred>();
    mockGateway.readBotSessions = jest.fn((botId: string) => {
      const gate = deferred();
      pending.set(botId, gate);
      return gate.promise;
    });

    await mount();

    // The screen's own controller, not some other signal: this is the object the
    // unmount below aborts, so a reader that only ever saw a private copy of it
    // would keep retrying behind the screen that left.
    const signals = (mockGateway.readBotSessions as jest.Mock).mock.calls.map(
      (call) => call[2] as AbortSignal,
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);

    await act(async () => {
      renderer?.unmount();
      renderer = undefined;
    });

    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);

    for (const gate of pending.values()) gate.resolve(catalogued('a'));
    await flush();
  });

  test('unmounting stops the lanes: no further Bot read is issued', async () => {
    roster.push(
      { id: 'a', displayName: 'A' },
      { id: 'b', displayName: 'B' },
      { id: 'c', displayName: 'C' },
      { id: 'd', displayName: 'D' },
    );
    const pending = new Map<string, Deferred>();
    mockGateway.readBotSessions = jest.fn((botId: string) => {
      const gate = deferred();
      pending.set(botId, gate);
      return gate.promise;
    });

    await mount();
    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      renderer?.unmount();
      renderer = undefined;
    });

    // Answering the two reads already on the wire releases their lanes; what
    // must not happen is the pool moving on to the rest of the roster.
    for (const gate of pending.values()) gate.resolve(catalogued('a'));
    await flush();

    expect(mockGateway.readBotSessions).toHaveBeenCalledTimes(2);
  });

  test('an abandoned wave never writes state — a superseded wave loses its report', async () => {
    roster.push({ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' });
    const pending = new Map<string, Deferred>();
    mockGateway.readBotSessions = jest.fn((botId: string) => {
      const gate = deferred();
      pending.set(botId, gate);
      return gate.promise;
    });

    await mount();
    expect(sectionReport()).toBeNull();

    // A different gateway: its wave supersedes the one in flight.
    roster.length = 0;
    roster.push({ id: 'b1', displayName: 'B1' });
    mockGateway.readBotSessions = jest.fn(async (botId: string) => catalogued(botId));
    await show('connected', 'gw-2');
    expect(sectionReport()?.rows.map((row) => row.botId)).toEqual(['b1']);

    // The abandoned wave's answers arriving late must not overwrite it.
    for (const gate of pending.values()) gate.resolve(catalogued('a'));
    await flush();

    expect(sectionReport()?.rows.map((row) => row.botId)).toEqual(['b1']);
  });
});

describe('a cap is persisted from committed state, not from a state updater', () => {
  function setBudget(botId: string, cap: number | undefined): void {
    const section = renderer?.root.findAllByType(SECTION)[0];
    expect(section).toBeDefined();
    const onSetBudget = section?.props.onSetBudget as (bot: string, cap: number | undefined) => void;
    onSetBudget(botId, cap);
  }

  test('the value read back from storage is not written straight back', async () => {
    (loadBudgets as jest.Mock).mockResolvedValue({ 'gw-1:a': 3 });

    await mount();

    expect(loadBudgets).toHaveBeenCalledTimes(1);
    expect(saveBudgets).not.toHaveBeenCalled();
  });

  test('setting a cap persists it exactly once', async () => {
    roster.push({ id: 'a', displayName: 'A' });
    await mount();

    await act(async () => {
      setBudget('a', 5);
    });
    await flush();

    expect(saveBudgets).toHaveBeenCalledTimes(1);
    expect(saveBudgets).toHaveBeenCalledWith({ 'gw-1:a': 5 });
  });

  test('two caps set in one tick persist the final map, once', async () => {
    roster.push({ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' });
    await mount();

    // Both land in the same commit, so the writer sees one change — the map
    // that actually committed. Issuing a write per updater would put two
    // requests on the store for a state that only ever had one value.
    await act(async () => {
      setBudget('a', 5);
      setBudget('b', 7);
    });
    await flush();

    expect(saveBudgets).toHaveBeenCalledTimes(1);
    expect(saveBudgets).toHaveBeenCalledWith({ 'gw-1:a': 5, 'gw-1:b': 7 });
  });
});

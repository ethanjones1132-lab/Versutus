/**
 * VS-004 — two MED defects on the Runs screen, pinned where they happened.
 *
 * 1. The per-Bot spend wave hung off the focus effect, and its loader closed
 *    over `status`. Every connection-monitor self-heal (connected → reconnecting
 *    → connected) therefore gave `loadBotSpend` a new identity, re-ran the
 *    focus effect, and its cleanup — the wave's walk-away — aborted the wave in
 *    flight and dropped its ticket. A running wave is one roster read plus one
 *    200-row catalogue read per Bot, so each flap paid for the whole fold again
 *    from zero. A status change is not a new read: only blur or unmount may end
 *    the wave, and a connection that comes back JOINS a wave still out.
 *
 * 2. `focusedRunId` was set once by a notice tap and never cleared, while the
 *    scroll effect depended on `[focusedRunId, listData]`. Every later run-list
 *    update — a live event, a status change — scrolled the list back to the
 *    tapped row and the ring stayed lit for the rest of the visit. One focus
 *    request is one scroll, and the highlight is spent with it.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-reanimated', () => {
  const builder = () => {
    const chain = {
      duration: () => chain,
      easing: () => chain,
      delay: () => chain,
      withInitialValues: () => chain,
    };
    return chain;
  };
  return {
    Easing: {
      bezier: () => (value: number) => value,
      elastic: () => (value: number) => value,
      ease: (value: number) => value,
      inOut: (fn: unknown) => fn,
      quad: (fn: unknown) => fn,
    },
    FadeIn: builder(),
    FadeInDown: builder(),
    FadeOut: builder(),
    Layout: { duration: () => undefined },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => ({ value }),
    withRepeat: () => undefined,
    withTiming: () => undefined,
    __esModule: true,
    default: { View: 'AnimatedView' },
  };
});

jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Button: 'Button',
  Card: 'Card',
  EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  PageTitle: 'PageTitle',
  PressableScale: 'PressableScale',
  Screen: 'Screen',
  SectionHeader: 'SectionHeader',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/components/layout/ComposerKeyboardLift', () => ({
  ComposerKeyboardLift: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/activity/activity-glance', () => ({ ActivityGlance: 'ActivityGlance' }));
jest.mock('@/components/activity/agentic-run-sheet', () => ({ AgenticRunSheet: 'AgenticRunSheet' }));
jest.mock('@/components/activity/run-card', () => ({ RunCard: 'RunCard' }));
jest.mock('@/components/activity/scorecards-section', () => ({ ScorecardsSection: 'ScorecardsSection' }));
jest.mock('@/components/connection-badge', () => ({ PulsingDot: 'PulsingDot' }));
jest.mock('@/lib/motion/ambient-parallax', () => ({
  useAmbientParallaxScroll: () => ({ parallaxY: { value: 0 }, onScroll: jest.fn() }),
}));
jest.mock('@/lib/haptics', () => ({
  haptics: {
    light: jest.fn(async () => undefined),
    medium: jest.fn(async () => undefined),
    selection: jest.fn(async () => undefined),
    success: jest.fn(async () => undefined),
    warning: jest.fn(async () => undefined),
    error: jest.fn(async () => undefined),
  },
}));
jest.mock('@/lib/gateway/spend-report', () => ({
  readBotSpend: (source: SpendSource, options?: SpendOptions) => mockReadBotSpend(source, options),
}));
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

type SpendSource = { listBots: () => Promise<unknown[]>; readBotSessions?: unknown };
type SpendOptions = { signal?: AbortSignal };

/** One wave this test parks and releases itself, with the signal it was handed. */
type ParkedWave = { signal: AbortSignal | undefined; rows: BotSpendRow[]; release: () => void };
const parkedWaves: ParkedWave[] = [];
/** Park a wave (the default) or answer at once — the focus tests need no wave. */
let holdWaves = true;

/** The fan-out as the real module runs it: without a scoped read it degrades
 * without asking the roster, and with one it asks the roster and parks a lane
 * per Bot. */
const mockReadBotSpend = jest.fn(
  (source: SpendSource, options?: SpendOptions): Promise<{ rows: BotSpendRow[]; degraded: boolean }> => {
    if (!source.readBotSessions) return Promise.resolve({ rows: [], degraded: true });
    void source.listBots();
    if (!holdWaves) return Promise.resolve({ rows: [row('Forge')], degraded: false });
    return new Promise<{ rows: BotSpendRow[]; degraded: boolean }>((resolve) => {
      const wave: ParkedWave = {
        signal: options?.signal,
        rows: [],
        release: () => resolve({ rows: wave.rows, degraded: false }),
      };
      parkedWaves.push(wave);
    });
  },
);

type FocusHook = { run: () => void; cleanup: (() => void) | undefined };
const focusHooks: FocusHook[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false }),
  // Real semantics, plus a handle on the edges: the focus effect runs, and its
  // cleanup runs on blur and on unmount. `blur`/`refocus` below drive the two.
  useFocusEffect: (effect: () => unknown) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => {
      const entry: FocusHook = {
        cleanup: undefined,
        run: () => {
          entry.cleanup = (effect() as (() => void) | undefined) ?? undefined;
        },
      };
      focusHooks.push(entry);
      entry.run();
      return () => {
        if (typeof entry.cleanup === 'function') entry.cleanup();
        const at = focusHooks.indexOf(entry);
        if (at >= 0) focusHooks.splice(at, 1);
      };
    }, [effect]);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { createElement, type ElementType } from 'react';
import { FlatList } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { ActivityRun } from '@/lib/gateway/runs';
import type { BotSpendRow } from '@/lib/gateway/spend-report';

import RunsScreen from '@/app/runs';

const SCORECARDS = 'ScorecardsSection' as ElementType;
const RUN_CARD = 'RunCard' as ElementType;
const SCROLL_SETTLE_MS = 300;

const gateway = (id: string) => ({ id, name: 'Home PC', url: 'http://alpha.test:8642', token: 'tok', createdAt: 0 });

const ROSTER = [{ id: 'forge', displayName: 'Forge' }];

function run(id: string): ActivityRun {
  return { id, prompt: id, status: 'complete', startedAt: 1, finishedAt: 2, events: [] };
}

function row(label: string): BotSpendRow {
  return { botId: label.toLowerCase(), label, basis: 'actual', tokens: 10, costUsd: 0.1, failed: false };
}

const mockGateway = {
  activeGateway: gateway('gw-1') as unknown as Record<string, unknown>,
  status: 'connected',
  capabilitySnapshot: { status: 'fresh', groups: [{ id: 'agent', status: 'ready' }], methods: {} },
  activityRunsForActiveGateway: [] as ActivityRun[],
  stopActivityRun: jest.fn(),
  connectGateway: jest.fn<Promise<void>, [unknown]>(async () => undefined),
  refreshCapabilities: jest.fn<Promise<boolean>, []>(async () => true),
  refreshGateways: jest.fn(async () => undefined),
  sendChatInput: jest.fn<Promise<string>, [string]>(async () => 'complete'),
  loadRunEvents: jest.fn(async () => [] as unknown[]),
  requestedRunFocus: null as { runId: string } | null,
  requestRunFocus: jest.fn(),
  clearRequestedRunFocus: jest.fn(),
  pendingApprovals: [] as unknown[],
  cron: { available: true, list: jest.fn(async () => []) },
  listBots: jest.fn(async () => ROSTER),
  readBotSessions: jest.fn(async () => []),
  canReadBotSessions: true,
};

let renderer: ReactTestRenderer | null = null;
let scrollToIndex: jest.SpyInstance;

async function settle(rounds = 8, ms = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** The blur edge: every focus effect's cleanup runs, as leaving the screen does. */
async function blur(): Promise<void> {
  await act(async () => {
    for (const entry of focusHooks) {
      if (typeof entry.cleanup === 'function') entry.cleanup();
      entry.cleanup = undefined;
    }
  });
}

/** The return edge: the same effects run again. */
async function refocus(): Promise<void> {
  await act(async () => {
    for (const entry of focusHooks) entry.run();
  });
  await settle();
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(RunsScreen));
  });
  await settle();
}

/** A re-render, which is how the screen sees a status, a capability or a run
 * list change underneath it. */
async function rerender(): Promise<void> {
  await act(async () => {
    renderer!.update(createElement(RunsScreen));
  });
  await settle();
}

/** The notice tap: the provider's pending slot names the run, as a tap fills it. */
async function requestFocus(runId: string): Promise<void> {
  mockGateway.requestedRunFocus = { runId };
  await rerender();
}

function scorecards(): { spendRows: BotSpendRow[]; botNames: Record<string, string> } {
  return renderer!.root.findByType(SCORECARDS).props as {
    spendRows: BotSpendRow[];
    botNames: Record<string, string>;
  };
}

/** Which run rows are lit right now. */
function highlightedRunIds(): string[] {
  return renderer!.root
    .findAllByType(RUN_CARD)
    .filter((node) => (node.props as { highlighted?: boolean }).highlighted === true)
    .map((node) => String((node.props as { run?: ActivityRun }).run?.id));
}

beforeEach(() => {
  jest.useFakeTimers();
  parkedWaves.length = 0;
  focusHooks.length = 0;
  holdWaves = true;
  mockGateway.status = 'connected';
  mockGateway.activeGateway = gateway('gw-1') as unknown as Record<string, unknown>;
  mockGateway.activityRunsForActiveGateway = [];
  mockGateway.requestedRunFocus = null;
  mockGateway.canReadBotSessions = true;
  mockGateway.cron.list.mockClear();
  mockGateway.listBots.mockClear();
  mockGateway.readBotSessions.mockClear();
  mockGateway.clearRequestedRunFocus.mockClear();
  mockReadBotSpend.mockClear();
  // The scroll is the observable: the list is real, its ref is the screen's, so
  // the prototype method is where a scroll request can be counted.
  scrollToIndex = jest
    .spyOn(FlatList.prototype as unknown as { scrollToIndex: (params: unknown) => void }, 'scrollToIndex')
    .mockImplementation(() => undefined);
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  scrollToIndex.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a connection flap is not a new spend wave', () => {
  test('connected → reconnecting → connected joins the wave already out', async () => {
    await mount();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
    const wave = parkedWaves[0];
    expect(wave?.signal).toBeInstanceOf(AbortSignal);
    expect(wave?.signal?.aborted).toBe(false);

    // The monitor's self-heal: one flap down and one back up.
    mockGateway.status = 'reconnecting';
    await rerender();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
    expect(wave?.signal?.aborted).toBe(false);

    mockGateway.status = 'connected';
    await rerender();
    // No second roster read plus one 200-row catalogue read per Bot: the fold
    // joined the wave that was already out.
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
    expect(wave?.signal?.aborted).toBe(false);

    // And the original wave still owns the rows: its answer paints, which a
    // wave whose ticket had been dropped could not do.
    if (wave) {
      wave.rows = [row('Forge')];
      await act(async () => {
        wave.release();
      });
    }
    await settle();
    expect(scorecards().spendRows.map((item) => item.label)).toEqual(['Forge']);
  });

  test('blur still ends a wave the flap left running', async () => {
    await mount();
    const wave = parkedWaves[0];

    mockGateway.status = 'reconnecting';
    await rerender();
    mockGateway.status = 'connected';
    await rerender();
    expect(wave?.signal?.aborted).toBe(false);

    await blur();
    expect(wave?.signal?.aborted).toBe(true);
  });

  test('unmount still ends a wave the flap left running', async () => {
    await mount();
    const wave = parkedWaves[0];

    mockGateway.status = 'reconnecting';
    await rerender();
    mockGateway.status = 'connected';
    await rerender();

    const doomed = renderer!;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });

    expect(wave?.signal?.aborted).toBe(true);
  });

  test('reconnecting after blur starts no wave until the screen is focused again', async () => {
    await mount();
    const first = parkedWaves[0];
    await blur();
    expect(first?.signal?.aborted).toBe(true);

    mockGateway.status = 'reconnecting';
    await rerender();
    mockGateway.status = 'connected';
    await rerender();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);

    await refocus();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(2);
    expect(parkedWaves[1]?.signal?.aborted).toBe(false);
  });

  test('a wave asked for while reconnecting is asked when the connection lands', async () => {
    // The connect edge is not lost with the flap: nothing was read while the
    // device was offline, so the landing is the first real ask.
    mockGateway.status = 'reconnecting';
    await mount();
    expect(mockReadBotSpend).not.toHaveBeenCalled();

    mockGateway.status = 'connected';
    await rerender();

    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
  });

  test('a return to the screen after the flap is still its own read', async () => {
    // The walk-away and the focus entry point are unchanged: a blur ends the
    // wave, and the focus on the way back starts a fresh one after the window.
    await mount();
    const first = parkedWaves[0];
    await act(async () => {
      if (first) {
        first.rows = [row('Forge')];
        first.release();
      }
    });
    await settle();

    mockGateway.status = 'reconnecting';
    await rerender();
    mockGateway.status = 'connected';
    await rerender();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);

    await advance(60_001);
    await blur();
    await refocus();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(2);
  });
});

describe('one focus request is one scroll', () => {
  beforeEach(() => {
    holdWaves = false;
    mockGateway.activityRunsForActiveGateway = [run('run-a'), run('run-b'), run('run-c')];
  });

  test('a later run-list update does not scroll again or keep the row lit', async () => {
    await mount();
    expect(scrollToIndex).not.toHaveBeenCalled();

    await requestFocus('run-b');
    // The request highlights the row the list actually holds…
    expect(highlightedRunIds()).toEqual(['run-b']);
    // …and the scroll has not landed yet.
    expect(scrollToIndex).not.toHaveBeenCalled();

    // A live event lands while the scroll is still pending — the update that
    // used to re-run the scroll effect.
    mockGateway.activityRunsForActiveGateway = [run('run-a'), run('run-b'), run('run-c'), run('run-d')];
    await rerender();
    expect(highlightedRunIds()).toEqual(['run-b']);

    await advance(SCROLL_SETTLE_MS);

    // Exactly one scroll, to the row the request named (the list is the Recent
    // label, then the three runs).
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex.mock.calls[0][0]).toMatchObject({ index: 2, animated: true, viewPosition: 0.15 });
    // The highlight is spent with that scroll, not kept for every later update.
    expect(highlightedRunIds()).toEqual([]);

    // A later update alone — no new request — moves nothing and lights nothing.
    mockGateway.activityRunsForActiveGateway = [run('run-d'), run('run-a'), run('run-b'), run('run-c')];
    await rerender();
    await advance(SCROLL_SETTLE_MS);

    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(highlightedRunIds()).toEqual([]);
  });

  test('a second tap is a fresh request and scrolls again', async () => {
    await mount();

    await requestFocus('run-b');
    await advance(SCROLL_SETTLE_MS);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(highlightedRunIds()).toEqual([]);

    await requestFocus('run-c');
    expect(highlightedRunIds()).toEqual(['run-c']);
    await advance(SCROLL_SETTLE_MS);

    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    // The list is the Recent label, run-a, run-b, run-c.
    expect(scrollToIndex.mock.calls[1][0]).toMatchObject({ index: 3 });
  });

  test('a request for a run the list does not hold retires without a scroll', async () => {
    await mount();

    await requestFocus('run-z');
    expect(highlightedRunIds()).toEqual([]);

    await advance(SCROLL_SETTLE_MS);
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(highlightedRunIds()).toEqual([]);
  });
});

/**
 * RUNS-1 — one fold per visit, and one read at a time inside it.
 *
 * Every screen-level read on Runs hung off TWO triggers: a `useFocusEffect` and
 * a `useEffect` keyed on the pull's reload signal — which starts at 0, so
 * mounting the screen fired both. On a ten-Bot Gate that is two roster reads,
 * twenty `limit=200` per-Bot catalogue reads and two `cron.list()` for one
 * screen open, each catalogue read given a 30 s bulk budget against a Gate the
 * repo documents as serving one request at a time. A third `listBots()` read the
 * roster the spend fold had just read, for the scorecards' names.
 *
 * Nothing deduplicated or aborted either: the `live` flag only stopped the
 * `setState`, so the duplicate requests still went out and still held the Gate.
 *
 * The fix folds each read once, coalesces what is already out and bounds the
 * spend wave by a freshness window — so the window itself has to be honest:
 * only a wave that actually READ may stamp it. A wave that ran while the screen
 * was disconnected, or that the gateway refused, claims nothing, or the connect
 * and the retry it was standing in for are swallowed for the whole minute and
 * the scorecards stay empty.
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

/** One wave the test parks or releases itself, with the signal it was handed. */
type ParkedWave = { signal: AbortSignal | undefined; rows: BotSpendRow[]; release: () => void };
const parkedWaves: ParkedWave[] = [];
const parkedCron: (() => void)[] = [];
/** How many of the next waves answer with a refusal instead of rows. */
let failWaves = 0;

/** The fan-out as the real module runs it: without a scoped read it degrades
 * without asking the roster, and with one it asks the roster and parks a lane
 * per Bot. */
const mockReadBotSpend = jest.fn(
  (source: SpendSource, options?: SpendOptions): Promise<{ rows: BotSpendRow[]; degraded: boolean }> => {
    if (failWaves > 0) {
      failWaves -= 1;
      return Promise.reject(new Error('the gateway refused the catalogue'));
    }
    if (!source.readBotSessions) return Promise.resolve({ rows: [], degraded: true });
    void source.listBots();
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
import { RefreshControl } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { BotSpendRow } from '@/lib/gateway/spend-report';

import RunsScreen from '@/app/runs';

const SCORECARDS = 'ScorecardsSection' as ElementType;
const REFRESH_WINDOW_MS = 60_000;

const gateway = (id: string) => ({ id, name: 'Home PC', url: 'http://alpha.test:8642', token: 'tok' });

const ROSTER = [{ id: 'forge', displayName: 'Forge' }];

const mockGateway = {
  activeGateway: gateway('gw-1') as unknown as Record<string, unknown>,
  status: 'connected',
  capabilitySnapshot: { status: 'fresh', groups: [{ id: 'agent', status: 'ready' }], methods: {} },
  activityRunsForActiveGateway: [] as unknown[],
  stopActivityRun: jest.fn(),
  connectGateway: jest.fn<Promise<void>, [unknown]>(async () => undefined),
  refreshCapabilities: jest.fn<Promise<boolean>, []>(async () => true),
  refreshGateways: jest.fn(async () => undefined),
  sendChatInput: jest.fn<Promise<string>, [string]>(async () => 'complete'),
  loadRunEvents: jest.fn(async () => [] as unknown[]),
  requestedRunFocus: null,
  requestRunFocus: jest.fn(),
  clearRequestedRunFocus: jest.fn(),
  pendingApprovals: [] as unknown[],
  cron: { available: true, list: jest.fn(() => new Promise((resolve) => {
    parkedCron.push(() => resolve([{ id: 'job-1', title: 'Job one' }]));
  })) },
  listBots: jest.fn(async () => ROSTER),
  readBotSessions: jest.fn(async () => []),
  canReadBotSessions: true,
};

let renderer: ReactTestRenderer | null = null;

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

/** A re-render, which is how a value the screen reads from the gateway — the
 * connection status, the per-Bot capability — changes underneath it. */
async function rerender(): Promise<void> {
  await act(async () => {
    renderer!.update(createElement(RunsScreen));
  });
  await settle();
}

async function pull(): Promise<void> {
  const control = renderer!.root.findByType(RefreshControl);
  await act(async () => {
    await control.props.onRefresh();
  });
  await settle();
}

function scorecards(): { jobs: unknown[]; spendRows: BotSpendRow[]; botNames: Record<string, string> } {
  return renderer!.root.findByType(SCORECARDS).props as {
    jobs: unknown[];
    spendRows: BotSpendRow[];
    botNames: Record<string, string>;
  };
}

const row = (label: string): BotSpendRow => ({
  botId: label.toLowerCase(),
  label,
  basis: 'actual',
  tokens: 10,
  costUsd: 0.1,
  failed: false,
});

/** Release every parked wave with the rows it was asked to answer. */
async function releaseAll(rowsFor: (wave: ParkedWave, index: number) => BotSpendRow[]): Promise<void> {
  const waves = [...parkedWaves];
  for (const [index, wave] of waves.entries()) {
    wave.rows = rowsFor(wave, index);
    await act(async () => {
      wave.release();
    });
  }
  await settle();
}

/** Let every parked `cron.list()` answer. */
async function releaseCron(): Promise<void> {
  const reads = [...parkedCron];
  parkedCron.length = 0;
  for (const read of reads) {
    await act(async () => {
      read();
    });
  }
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  parkedWaves.length = 0;
  parkedCron.length = 0;
  focusHooks.length = 0;
  failWaves = 0;
  mockGateway.status = 'connected';
  mockGateway.canReadBotSessions = true;
  mockGateway.cron.list.mockClear();
  mockGateway.listBots.mockClear();
  mockGateway.readBotSessions.mockClear();
  mockReadBotSpend.mockClear();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('opening Runs folds each read once', () => {
  test('one screen open issues one cron read and one spend wave', async () => {
    await mount();

    expect(mockGateway.cron.list).toHaveBeenCalledTimes(1);
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
    // The wave carries the walk-away, so an abandoned lane grows no second
    // attempt behind the one the caller walked away from.
    expect(parkedWaves[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('the roster is read by the spend fold alone, and its rows still name the Bots', async () => {
    // The screen used to read the roster a third time, for names this fold's own
    // rows already carry.
    await mount();
    await releaseAll(() => [row('Forge')]);

    expect(mockGateway.listBots).toHaveBeenCalledTimes(1);
    expect(scorecards().spendRows.map((item) => item.label)).toEqual(['Forge']);
    expect(scorecards().botNames).toEqual({ forge: 'Forge' });
  });

  test('a gateway that cannot answer the scoped read still reads the roster once, for names', async () => {
    mockGateway.canReadBotSessions = false;
    await mount();
    await releaseAll(() => []);

    // `readBotSpend` degrades without asking the roster on that path, so the
    // fold asks for the names itself: otherwise every scorecard on such a
    // gateway is titled with a Bot id where it used to read "Forge".
    expect(mockGateway.readBotSessions).not.toHaveBeenCalled();
    expect(mockGateway.listBots).toHaveBeenCalledTimes(1);
    expect(scorecards().botNames).toEqual({ forge: 'Forge' });

    // And it rides the same freshness window: a return inside it asks nothing.
    await blur();
    await refocus();
    expect(mockGateway.listBots).toHaveBeenCalledTimes(1);
  });

  test('the per-Bot capability arriving earns the scoped wave', async () => {
    // The provider sets this during connect, so a gateway that could only
    // degrade is briefly one that can be asked properly. The wave answered
    // without the scoped read says nothing about that one.
    mockGateway.canReadBotSessions = false;
    await mount();
    const before = mockReadBotSpend.mock.calls.length;

    mockGateway.canReadBotSessions = true;
    await rerender();

    expect(mockReadBotSpend.mock.calls.length).toBe(before + 1);
    await releaseAll(() => [row('Forge')]);
    expect(scorecards().botNames).toEqual({ forge: 'Forge' });
  });

  test('a pull to refresh adds exactly one of each', async () => {
    await mount();
    await releaseCron();
    await releaseAll(() => [row('Forge')]);
    expect(mockGateway.cron.list).toHaveBeenCalledTimes(1);
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);

    await pull();

    expect(mockGateway.cron.list).toHaveBeenCalledTimes(2);
    // Forced even inside the freshness window: a pull is the operator saying
    // the rows on screen are stale.
    expect(mockReadBotSpend).toHaveBeenCalledTimes(2);
  });
});

describe('one read at a time inside a fold', () => {
  test('a caller arriving while a read is in flight joins it', async () => {
    // Nothing resolves yet: the mount's two reads are still out when the pull
    // arrives.
    await mount();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
    expect(mockGateway.cron.list).toHaveBeenCalledTimes(1);

    await pull();

    // The pull goes through the same entry point, so it waits for the reads that
    // are already running instead of putting a second of each behind them.
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
    expect(mockGateway.cron.list).toHaveBeenCalledTimes(1);

    await releaseCron();
    await releaseAll(() => [row('Forge')]);
    expect(scorecards().spendRows).toHaveLength(1);
    expect(scorecards().jobs).toHaveLength(1);
  });

  test('a return inside the freshness window, after a wave that read rows, skips the wave', async () => {
    await mount();
    await releaseCron();
    await releaseAll(() => [row('Forge')]);
    // The window only rests on a wave that read something, so the rows it
    // brought are the proof that this is that case.
    expect(scorecards().spendRows).toHaveLength(1);

    await blur();
    await refocus();

    // The job list is cheap and per-visit, so a return re-reads it…
    expect(mockGateway.cron.list).toHaveBeenCalledTimes(2);
    // …while the per-Bot fan-out waits for its window. It was this screen's
    // doubled reads of the same roster that kept a Gate busy.
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
  });

  test('a return after the window earns a fresh wave', async () => {
    await mount();
    await releaseCron();
    await releaseAll(() => [row('Forge')]);

    await advance(REFRESH_WINDOW_MS + 1);
    await blur();
    await refocus();

    expect(mockReadBotSpend).toHaveBeenCalledTimes(2);
  });
});

describe('a fold that read nothing claims no freshness', () => {
  test('the connect that lands reads the wave a disconnected fold never ran', async () => {
    // Runs opened while auto-connect is still running — or the operator pressed
    // Reconnect on this very screen. There is nothing to read yet, so no wave is
    // created; and a wave that asked nothing may not claim the window either, or
    // the connect landing a moment later is swallowed by it and the scorecards
    // stay empty for the whole minute.
    mockGateway.status = 'connecting';
    await mount();
    expect(mockReadBotSpend).not.toHaveBeenCalled();

    mockGateway.status = 'connected';
    await rerender();

    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);
    await releaseAll(() => [row('Forge')]);
    expect(scorecards().spendRows.map((item) => item.label)).toEqual(['Forge']);
  });

  test('a read that throws is asked again on the next edge, not after the window', async () => {
    failWaves = 1;
    await mount();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);

    await blur();
    await refocus();

    // The window only rests on a wave that read something, so the refusal buys
    // no minute of silence.
    expect(mockReadBotSpend).toHaveBeenCalledTimes(2);
  });

  test('a read that throws leaves the rows the last complete wave read on screen', async () => {
    await mount();
    await releaseCron();
    await releaseAll(() => [row('Forge')]);
    expect(scorecards().spendRows.map((item) => item.label)).toEqual(['Forge']);

    failWaves = 1;
    await pull();

    expect(mockReadBotSpend).toHaveBeenCalledTimes(2);
    // A failed re-read is not an answer: blanking here would claim a zero the
    // gateway never sent.
    expect(scorecards().spendRows.map((item) => item.label)).toEqual(['Forge']);
  });
});

describe('the wave that owns the rows is the newest one', () => {
  test('an older wave that lands last never overwrites the newer rows', async () => {
    await mount();
    await releaseCron();
    const first = parkedWaves[0];
    expect(mockReadBotSpend).toHaveBeenCalledTimes(1);

    // The operator leaves with the wave still out, and comes back: the walk-away
    // ended it and the return starts a wave of its own.
    await blur();
    await refocus();
    expect(mockReadBotSpend).toHaveBeenCalledTimes(2);
    const second = parkedWaves[1];
    expect(first?.signal?.aborted).toBe(true);
    expect(second?.signal?.aborted).toBe(false);

    // The newer wave answers first, then the abandoned one.
    if (second) {
      second.rows = [row('Current')];
      await act(async () => {
        second.release();
      });
    }
    await settle();
    expect(scorecards().spendRows.map((item) => item.label)).toEqual(['Current']);

    if (first) {
      first.rows = [row('Stale')];
      await act(async () => {
        first.release();
      });
    }
    await settle();

    expect(scorecards().spendRows.map((item) => item.label)).toEqual(['Current']);
  });

  test('an unmount ends the wave in flight', async () => {
    await mount();
    // The wave is still out, with its roster read already asked and one lane per
    // Bot still to issue.
    expect(parkedWaves).toHaveLength(1);

    const doomed = renderer!;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
    await settle();

    // The signal reaches each Bot read's retry ladder, so no further lane is
    // issued for a screen nobody is looking at.
    expect(parkedWaves[0]?.signal?.aborted).toBe(true);
    // And nothing is left to release a lane: the wave is over.
    if (parkedWaves[0]) {
      parkedWaves[0].rows = [row('AfterUnmount')];
      await act(async () => {
        parkedWaves[0].release();
      });
    }
    await settle();
  });
});
/**
 * RUNS-2, V-1 and the Runs half of RUNS-3, rendered.
 *
 * `startRun` read the `SendChatInputOutcome` for one value and the `finally`
 * reset `starting` unconditionally, so every outcome painted the idle card. For
 * 'error' and 'cancelled' that is by design and test-locked elsewhere (the kept
 * draft is the signal, and the provider's `lastError` is a surface Chat and Home
 * both render). The 'queued' outcome had no representation at all: the run went
 * to the offline outbox, which clears that banner on purpose, so the screen
 * said nothing while a later flush started the run.
 *
 * `retryRun` was worse: it discarded the outcome, kept no pending state and had
 * no guard, so a refused, queued or colliding retry reported nothing here and a
 * second tap fired a second `/run`.
 *
 * `onRefresh` could only ever see a storage failure, because
 * `refreshCapabilities` swallowed every gateway-side read — so a gateway
 * refusing all of them ended the pull as a success over data nothing re-read.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-reanimated', () => {
  // The layout builders are chained (`.duration().easing().delay()`), so the
  // stand-in is chainable rather than a value.
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
  readBotSpend: (source: unknown, options?: unknown) => mockReadBotSpend(source, options),
}));
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

const mockReadBotSpend = jest.fn(
  async (
    _source: unknown,
    _options?: unknown,
  ): Promise<{ rows: BotSpendRow[]; degraded: boolean }> => ({ rows: [], degraded: false }),
);

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => effect(), [effect]);
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

const BUTTON = 'Button' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
const TEXT = 'Text' as ElementType;
const RUN_CARD = 'RunCard' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;
const EMPTY_STATE = 'EmptyState' as ElementType;

const gateway = (id: string) => ({
  id,
  name: 'Home PC',
  url: 'http://alpha.test:8642',
  token: 'tok',
  createdAt: 0,
});

const FAILED_RUN = {
  id: 'run-1',
  prompt: 'summarise the log',
  status: 'failed' as const,
  startedAt: 1,
  finishedAt: 2,
  summary: 'the gateway refused',
  events: [],
};

const mockGateway = {
  activeGateway: gateway('gw-1') as unknown as Record<string, unknown>,
  status: 'connected',
  capabilitySnapshot: { status: 'fresh', groups: [{ id: 'agent', status: 'ready' }], methods: {} },
  activityRunsForActiveGateway: [] as unknown[],
  stopActivityRun: jest.fn(),
  connectGateway: jest.fn<Promise<void>, [unknown]>(async () => undefined),
  // The real seam resolves `true` for a refresh whose reads landed and `false`
  // for one that was refused (RUNS-3); nothing here rejects any more.
  refreshCapabilities: jest.fn<Promise<boolean>, []>(async () => true),
  refreshGateways: jest.fn(async () => undefined),
  sendChatInput: jest.fn<Promise<string>, [string]>(async () => 'complete'),
  loadRunEvents: jest.fn(async () => [] as unknown[]),
  requestedRunFocus: null,
  requestRunFocus: jest.fn(),
  clearRequestedRunFocus: jest.fn(),
  pendingApprovals: [] as unknown[],
  cron: { available: true, list: jest.fn(async () => []) },
  listBots: jest.fn(async () => []),
  readBotSessions: jest.fn(async () => []),
  // A gateway that can answer the scoped read, so the spend fold's own roster
  // supplies both the rows and the names the screen paints.
  canReadBotSessions: true,
};

let renderer: ReactTestRenderer | null = null;

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(RunsScreen));
  });
  await settle();
}

/** A re-render, which is how the connection status changes under the screen. */
async function rerender(): Promise<void> {
  await act(async () => {
    renderer!.update(createElement(RunsScreen));
  });
  await settle();
}

function buttonWithLabel(label: string): { label: string; onPress?: () => void; disabled?: boolean } {
  const found = renderer!.root.findAllByType(BUTTON).filter((node) => node.props?.label === label);
  expect(found.length).toBeGreaterThan(0);
  return found[0].props as { label: string; onPress?: () => void; disabled?: boolean };
}

async function press(label: string): Promise<void> {
  const button = buttonWithLabel(label);
  await act(async () => {
    (button.onPress as () => void)();
  });
  await settle();
}

async function typeInto(label: string, text: string): Promise<void> {
  const field = renderer!.root
    .findAllByType(TEXT_FIELD)
    .find((node) => node.props?.accessibilityLabel === label);
  expect(field).toBeTruthy();
  await act(async () => {
    ((field as unknown as { props: { onChangeText: (next: string) => void } }).props.onChangeText)(text);
  });
}

function promptValue(): string {
  const field = renderer!.root
    .findAllByType(TEXT_FIELD)
    .find((node) => node.props?.accessibilityLabel === 'Run prompt');
  expect(field).toBeTruthy();
  return ((field as unknown as { props: { value: string } }).props.value);
}

/** Every string this screen is currently drawing, in order. */
function drawnText(): string[] {
  return renderer!.root
    .findAllByType(TEXT)
    .map((node) => String((node.props?.children ?? '')))
    .filter((text) => text.length > 0);
}

function finishedCards(): { onRetry?: (prompt: string) => void }[] {
  return renderer!.root
    .findAllByType(RUN_CARD)
    .map((node) => node.props as { onRetry?: (prompt: string) => void });
}

/** Fire the card's own retry affordance, as a tap on it would. */
async function tapRetry(card: { onRetry?: (prompt: string) => void }): Promise<void> {
  expect(typeof card.onRetry).toBe('function');
  await act(async () => {
    (card.onRetry as (prompt: string) => void)('summarise the log');
  });
}

async function pull(): Promise<void> {
  const control = renderer!.root.findByType(RefreshControl);
  await act(async () => {
    await control.props.onRefresh();
  });
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGateway.status = 'connected';
  mockGateway.canReadBotSessions = true;
  mockGateway.activeGateway = gateway('gw-1');
  mockGateway.activityRunsForActiveGateway = [];
  mockGateway.connectGateway.mockClear();
  mockGateway.connectGateway.mockImplementation(async () => undefined);
  mockGateway.refreshCapabilities.mockClear();
  mockGateway.refreshCapabilities.mockImplementation(async () => true);
  mockGateway.refreshGateways.mockClear();
  mockGateway.sendChatInput.mockClear();
  mockGateway.sendChatInput.mockImplementation(async () => 'complete');
  mockReadBotSpend.mockClear();
  mockReadBotSpend.mockImplementation(async () => ({ rows: [], degraded: false }));
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

describe('a run started here reports where it went (RUNS-2)', () => {
  test("a 'queued' outcome says so on the card and keeps the draft", async () => {
    // The connection died between the render that enabled the button and the
    // press, so the slash line is parked in the outbox — which clears the
    // banner Chat and Home render. Without a line here this is the same card as
    // a refusal, and a later flush starts a run nobody saw start.
    mockGateway.sendChatInput.mockImplementation(async () => 'queued');
    await mount();
    await typeInto('Run prompt', 'summarise the log');
    await press('Run task');

    expect(mockGateway.sendChatInput).toHaveBeenCalledWith('/run summarise the log');
    expect(drawnText().join(' ')).toMatch(/Not sent .*offline/i);
    // The draft is kept, exactly as a refusal keeps it.
    expect(promptValue()).toBe('summarise the log');
  });

  test("a 'complete' outcome clears the draft and leaves no note", async () => {
    await mount();
    await typeInto('Run prompt', 'summarise the log');
    await press('Run task');

    expect(promptValue()).toBe('');
    expect(drawnText().join(' ')).not.toMatch(/Not sent/i);
  });

  test("a refused run still keeps the draft and still says nothing here", async () => {
    // Unchanged behaviour, pinned: the kept draft is this screen's signal for a
    // refusal, and the provider's `lastError` is the surface that names it.
    mockGateway.sendChatInput.mockImplementation(async () => 'error');
    await mount();
    await typeInto('Run prompt', 'summarise the log');
    await press('Run task');

    expect(promptValue()).toBe('summarise the log');
    expect(drawnText().join(' ')).not.toMatch(/Not sent/i);
  });

  test('the note is retired by the next edit', async () => {
    mockGateway.sendChatInput.mockImplementation(async () => 'queued');
    await mount();
    await typeInto('Run prompt', 'summarise the log');
    await press('Run task');
    expect(drawnText().join(' ')).toMatch(/Not sent/i);

    await typeInto('Run prompt', 'summarise the log again');
    expect(drawnText().join(' ')).not.toMatch(/Not sent/i);
  });
});

describe('the retry card answers its own send (V-1)', () => {
  beforeEach(() => {
    mockGateway.activityRunsForActiveGateway = [FAILED_RUN];
  });

  test('two taps in one turn send once, and the affordance is gone while it flies', async () => {
    let release: (value: string) => void = () => undefined;
    mockGateway.sendChatInput.mockImplementation(
      () => new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    await mount();
    const card = finishedCards()[0];

    await act(async () => {
      (card.onRetry as (prompt: string) => void)('summarise the log');
      (card.onRetry as (prompt: string) => void)('summarise the log');
    });

    expect(mockGateway.sendChatInput).toHaveBeenCalledTimes(1);
    expect(drawnText().join(' ')).toMatch(/Retrying/);
    // The pending card offers no retry at all, so a second tap has nothing to
    // press rather than a button that quietly does nothing.
    expect(finishedCards()[0].onRetry).toBeUndefined();

    await act(async () => {
      release('complete');
    });
    await settle();
    // Success needs no line: the run it started is a new card in the list.
    expect(drawnText().join(' ')).not.toMatch(/Retry did not start/i);
    expect(typeof finishedCards()[0].onRetry).toBe('function');
  });

  test("a 'queued' retry says the run is parked, on the card it was tapped from", async () => {
    mockGateway.sendChatInput.mockImplementation(async () => 'queued');
    await mount();
    await tapRetry(finishedCards()[0]);

    expect(mockGateway.sendChatInput).toHaveBeenCalledWith('/run summarise the log');
    expect(drawnText().join(' ')).toMatch(/Not sent .*offline/i);
  });

  test.each(['error', 'cancelled', 'busy'])("a '%s' retry says it did not start", async (outcome) => {
    mockGateway.sendChatInput.mockImplementation(async () => outcome);
    await mount();
    await tapRetry(finishedCards()[0]);

    expect(drawnText().join(' ')).toMatch(/Retry did not start/i);
  });

  test('the next attempt retires the previous verdict', async () => {
    mockGateway.sendChatInput.mockImplementation(async () => 'error');
    await mount();
    await tapRetry(finishedCards()[0]);
    expect(drawnText().join(' ')).toMatch(/Retry did not start/i);

    mockGateway.sendChatInput.mockImplementation(async () => 'complete');
    await tapRetry(finishedCards()[0]);
    expect(drawnText().join(' ')).not.toMatch(/Retry did not start/i);
  });

  test('a send that rejects outright still releases the card', async () => {
    mockGateway.sendChatInput.mockImplementation(async () => {
      throw new Error('the transport gave up');
    });
    await mount();
    await tapRetry(finishedCards()[0]);

    expect(drawnText().join(' ')).toMatch(/Retry did not start/i);
    // Released through the `finally`: a card stuck on "Retrying…" could never be
    // retried again, so the affordance is back.
    expect(drawnText().join(' ')).not.toMatch(/Retrying/);
    expect(typeof finishedCards()[0].onRetry).toBe('function');
  });
});

describe('a pull says whether the gateway was actually re-read (RUNS-3)', () => {
  test('a refresh that read nothing is named, and the rows on screen stay', async () => {
    mockGateway.refreshCapabilities.mockImplementation(async () => false);
    mockReadBotSpend.mockImplementation(async () => ({
      rows: [
        { botId: 'forge', label: 'Forge', basis: 'actual', tokens: 10, costUsd: 0.1, failed: false },
      ],
      degraded: false,
    }));
    await mount();
    await settle();
    const scorecards = () => renderer!.root.findByType('ScorecardsSection' as ElementType).props as {
      spendRows: unknown[];
    };
    expect(scorecards().spendRows).toHaveLength(1);

    await pull();

    const cards = renderer!.root.findAllByType(ERROR_CARD);
    expect(cards.length).toBeGreaterThan(0);
    expect((cards[0].props as { cause?: string }).cause).toMatch(/Couldn't refresh from the gateway/);
    // The old data is still what is on screen — a failed re-read must not blank
    // rows it never replaced.
    expect(scorecards().spendRows).toHaveLength(1);
  });

  test('a refresh that succeeded clears the notice', async () => {
    mockGateway.refreshCapabilities.mockImplementation(async () => false);
    await mount();
    await pull();
    expect(renderer!.root.findAllByType(ERROR_CARD).length).toBeGreaterThan(0);

    mockGateway.refreshCapabilities.mockImplementation(async () => true);
    await pull();
    expect(renderer!.root.findAllByType(ERROR_CARD)).toHaveLength(0);
  });

  test('a storage failure still names itself, exactly as before', async () => {
    mockGateway.refreshGateways.mockImplementation(async () => {
      throw new Error('secure storage is locked');
    });
    await mount();
    await pull();

    const cards = renderer!.root.findAllByType(ERROR_CARD);
    expect(cards.length).toBeGreaterThan(0);
    expect((cards[0].props as { cause?: string }).cause).toMatch(/secure storage/);
  });

  test('a gateway that answers again retires the notice without a pull', async () => {
    // The notice describes a gateway that was refusing reads. A monitor
    // self-heal brings the connection back on its own, and the fold's read
    // lands on it — the state the notice was about has passed, so it must not
    // stay up until the operator remembers to pull.
    mockGateway.status = 'reconnecting';
    mockGateway.refreshCapabilities.mockImplementation(async () => false);
    await mount();
    await pull();
    expect(renderer!.root.findAllByType(ERROR_CARD).length).toBeGreaterThan(0);

    mockGateway.status = 'connected';
    await rerender();

    expect(renderer!.root.findAllByType(ERROR_CARD)).toHaveLength(0);
  });
});

describe('the Reconnect action cannot leave a rejection unhandled', () => {
  test('a refused key is named on the screen', async () => {
    // `connectGateway` rethrows an auth refusal by design, and this action is
    // fire-and-forget: unhandled before, and diagnosable only in the local
    // failure log.
    mockGateway.status = 'disconnected';
    mockGateway.connectGateway.mockImplementation(async () => {
      throw new Error('Gateway refused this key');
    });
    await mount();

    const empty = renderer!.root.findByType(EMPTY_STATE);
    await act(async () => {
      ((empty.props as { onAction?: () => void }).onAction as () => void)();
    });
    await settle();

    expect(mockGateway.connectGateway).toHaveBeenCalled();
    const cards = renderer!.root.findAllByType(ERROR_CARD);
    expect(cards.length).toBeGreaterThan(0);
    expect((cards[0].props as { cause?: string }).cause).toMatch(/refused this key/);
  });

  test('a connect that succeeds changes nothing about the screen', async () => {
    mockGateway.status = 'disconnected';
    mockGateway.connectGateway.mockImplementation(async () => undefined);
    await mount();

    const empty = renderer!.root.findByType(EMPTY_STATE);
    await act(async () => {
      ((empty.props as { onAction?: () => void }).onAction as () => void)();
    });
    await settle();

    expect(mockGateway.connectGateway).toHaveBeenCalled();
    expect(renderer!.root.findAllByType(ERROR_CARD)).toHaveLength(0);
  });
});
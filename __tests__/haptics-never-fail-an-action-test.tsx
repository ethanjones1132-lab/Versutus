/**
 * HAPTIC-1 / ONB-3 / ONB-1 — the three verified worst cases, rendered with
 * `expo-haptics` refusing in both of its shapes (a rejected promise, and a
 * throw before any promise exists), which is what a phone whose build dropped
 * the native module or whose vibrator is not a `VibratorManager` actually
 * produces.
 *
 * Before the fix each of these buttons was `await`ing the raw library:
 *
 *   Runs `startRun`  setStarting(true) THEN the await, outside the `try`, so
 *                    the `finally` never ran and the card wedged on a
 *                    disabled "Starting…" for the life of the mount.
 *   Onboarding       the await came before `setWorking(true)` and before the
 *                    `try`, so Connect did nothing at all — no error card, no
 *                    navigation — and the `catch` recorded its error only
 *                    after a second unguarded await.
 *   Retry            `void retryAutoConnect()` with no rejection handler of
 *                    its own; the probe ladder's own callers catch, this one
 *                    did not.
 */
const mockHapticsMode = { throws: false, rejects: true };

jest.mock('expo-haptics', () => {
  const call = () => {
    if (mockHapticsMode.throws) throw new Error("UnavailabilityError: Haptic.impactAsync");
    if (mockHapticsMode.rejects) return Promise.reject(new Error("UnavailabilityError: Haptic.impactAsync"));
    return Promise.resolve(undefined);
  };
  return {
    __esModule: true,
    impactAsync: jest.fn(call),
    notificationAsync: jest.fn(call),
    selectionAsync: jest.fn(call),
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#0af',
    accentMuted: '#00f2',
    backgroundElevated: '#111',
    border: '#333',
    borderSubtle: '#222',
    textPrimary: '#fff',
    textTertiary: '#777',
    statusConnected: '#0f0',
  }),
}));
jest.mock('@/hooks/use-now', () => ({ useNow: () => Date.now() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, top: 0 }) }));
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
jest.mock('@/components/layout/ComposerKeyboardLift', () => ({
  ComposerKeyboardLift: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/lib/motion/ambient-parallax', () => ({
  useAmbientParallaxScroll: () => ({ parallaxY: { value: 0 }, onScroll: jest.fn() }),
}));
jest.mock('@/components/activity/activity-glance', () => ({ ActivityGlance: 'ActivityGlance' }));
jest.mock('@/components/activity/agentic-run-sheet', () => ({ AgenticRunSheet: 'AgenticRunSheet' }));
jest.mock('@/components/activity/run-card', () => ({ RunCard: 'RunCard' }));
jest.mock('@/components/activity/scorecards-section', () => ({ ScorecardsSection: 'ScorecardsSection' }));
jest.mock('@/components/connection-badge', () => ({
  PulsingDot: 'PulsingDot',
  statusColor: () => '#fff',
  statusLabel: () => 'connected',
}));
jest.mock('@/components/brand', () => ({ VersutusLogotype: 'VersutusLogotype' }));
jest.mock('@/components/connection-timeline', () => ({
  ConnectionTimeline: 'ConnectionTimeline',
  CONNECTION_TIMELINE_STEPS_LONG: [],
}));
jest.mock('@/lib/gateway/spend-report', () => ({ readBotSpend: jest.fn(async () => ({ rows: [] })) }));
// Host stand-ins for the kit primitives: the sheets and cards pull in the
// motion presets, whose `FadeIn`/`FadeOut` builders have no jest-expo stand-in.
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

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn(), canGoBack: () => true }),
  useFocusEffect: () => undefined,
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';
import RunsScreen from '@/app/runs';

// Stand-in host names for the mocked UI primitives; not real JSX intrinsics,
// so they need an ElementType cast for findAllByType.
const BUTTON = 'Button' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;

const gateway = (id: string) => ({ id, url: 'http://localhost', token: 't', name: 'Home PC', kind: 'hermes' });

let connectResult: { kind: string; gatewayName?: string } = { kind: 'unreachable' };
let connectFails = false;

const mockGateway = {
  activeGateway: gateway('gw-1'),
  status: 'connected',
  capabilitySnapshot: { status: 'fresh', groups: [{ id: 'agent', status: 'ready' }], methods: {} },
  activityRunsForActiveGateway: [] as unknown[],
  stopActivityRun: jest.fn(),
  connectGateway: jest.fn(),
  refreshCapabilities: jest.fn(async () => undefined),
  refreshGateways: jest.fn(async () => undefined),
  sendChatInput: jest.fn<Promise<string>, [string]>(async () => 'complete'),
  loadRunEvents: jest.fn(async () => [] as unknown[]),
  requestedRunFocus: null,
  requestRunFocus: jest.fn(),
  clearRequestedRunFocus: jest.fn(),
  pendingApprovals: [] as unknown[],
  cron: { available: false, list: jest.fn(async () => []) },
  listBots: jest.fn(async () => []),
  readBotSessions: jest.fn(async () => []),
  canReadBotSessions: false,
  // Onboarding
  setupFromPcAddress: jest.fn(async () => connectResult),
  probeMessage: 'no gateway found',
  connectionPhase: 'failed' as string,
  settings: { tailscaleHost: 'home.test' },
  retryAutoConnect: jest.fn(async () => undefined),
};

let renderer: ReactTestRenderer;

function press(label: string): void {
  const button = buttonWithLabel(label);
  expect(typeof button.onPress).toBe('function');
  (button.onPress as () => void)();
}

/** The mocked host primitives carry their props verbatim, so the label is the handle. */
function buttonWithLabel(label: string): { label: string; onPress?: () => void; disabled?: boolean; busy?: boolean } {
  const found = renderer.root.findAllByType(BUTTON).filter((node) => node.props?.label === label);
  expect(found.length).toBeGreaterThan(0);
  return found[0].props as { label: string; onPress?: () => void; disabled?: boolean; busy?: boolean };
}

async function typeInto(label: string, text: string): Promise<void> {
  const field = renderer.root
    .findAllByType(TEXT_FIELD)
    .find((node) => node.props?.accessibilityLabel === label);
  expect(field).toBeTruthy();
  await act(async () => {
    ((field as unknown as { props: { onChangeText: (next: string) => void } }).props.onChangeText)(text);
  });
}

/** Drain the microtask queue and anything the screen deferred to a timer. */
async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
  }
}

async function mount(element: React.ReactElement): Promise<void> {
  await act(async () => {
    renderer = create(element);
  });
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockHapticsMode.throws = false;
  mockHapticsMode.rejects = true;
  mockPush.mockClear();
  mockReplace.mockClear();
  mockGateway.status = 'connected';
  mockGateway.connectionPhase = 'failed';
  mockGateway.probeMessage = 'no gateway found';
  mockGateway.sendChatInput.mockClear();
  mockGateway.sendChatInput.mockImplementation(async () => 'complete');
  mockGateway.setupFromPcAddress.mockClear();
  mockGateway.retryAutoConnect.mockClear();
  mockGateway.retryAutoConnect.mockImplementation(async () => undefined);
  connectResult = { kind: 'unreachable' };
  connectFails = false;
  mockGateway.setupFromPcAddress.mockImplementation(async () => {
    if (connectFails) throw new Error('The keychain is locked');
    return connectResult;
  });
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("Runs' startRun cannot be stopped by a haptic (HAPTIC-1)", () => {
  test('the run is sent and the card settles when the native call rejects', async () => {
    await mount(createElement(RunsScreen));
    await typeInto('Run prompt', 'summarise the log');
    await settle();
    await act(async () => {
      press('Run task');
    });
    await settle();

    expect(mockGateway.sendChatInput).toHaveBeenCalledWith('/run summarise the log');
    // The `finally` ran, so the button is the idle one again rather than a
    // card wedged on "Starting…" until the screen remounts.
    expect(buttonWithLabel('Run task').busy).not.toBe(true);
  });

  test('the run is sent and the card settles when the native call throws synchronously', async () => {
    mockHapticsMode.throws = true;
    await mount(createElement(RunsScreen));
    await typeInto('Run prompt', 'summarise the log');
    await settle();
    await act(async () => {
      press('Run task');
    });
    await settle();

    expect(mockGateway.sendChatInput).toHaveBeenCalledWith('/run summarise the log');
    expect(buttonWithLabel('Run task').busy).not.toBe(true);
  });

  test('a refusal from the send still settles the card', async () => {
    mockGateway.sendChatInput.mockImplementation(async () => 'error');
    await mount(createElement(RunsScreen));
    await typeInto('Run prompt', 'summarise the log');
    await settle();
    await act(async () => {
      press('Run task');
    });
    await settle();

    expect(mockGateway.sendChatInput).toHaveBeenCalled();
    expect(buttonWithLabel('Run task').busy).not.toBe(true);
  });
});

describe("Onboarding's Connect cannot be stopped by a haptic (ONB-3)", () => {
  test('the connect runs and the failure is named when the native call rejects', async () => {
    connectResult = { kind: 'unreachable' };
    await mount(createElement(OnboardingScreen));

    await act(async () => {
      press('Connect gateway');
    });
    await settle();

    expect(mockGateway.setupFromPcAddress).toHaveBeenCalled();
    // The operator is told the gateway could not be reached — the failure the
    // dead button used to swallow.
    expect(renderer.root.findAllByType(ERROR_CARD).length).toBeGreaterThan(0);
  });

  test('a thrown connect is still named, and the CTA comes back', async () => {
    connectFails = true;
    await mount(createElement(OnboardingScreen));

    await act(async () => {
      press('Connect gateway');
    });
    await settle();

    expect(mockGateway.setupFromPcAddress).toHaveBeenCalled();
    const card = renderer.root.findAllByType(ERROR_CARD)[0];
    expect(card).toBeTruthy();
    expect((card.props as { cause?: string }).cause).toContain('keychain');
    // `working` cleared through the `finally`, so the form is not locked.
    expect(buttonWithLabel('Connect gateway').disabled).toBe(false);
  });

  test('a successful connect navigates even when the native call throws synchronously', async () => {
    mockHapticsMode.throws = true;
    connectResult = { kind: 'connected' };
    await mount(createElement(OnboardingScreen));

    await act(async () => {
      press('Connect gateway');
    });
    await settle();

    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/chat');
  });
});

describe('the onboarding Retry button still fires its handler (ONB-1)', () => {
  test('Retry calls retryAutoConnect while haptics reject', async () => {
    await mount(createElement(OnboardingScreen));
    expect(buttonWithLabel('Retry')).toBeTruthy();

    await act(async () => {
      press('Retry');
    });
    await settle();

    expect(mockGateway.retryAutoConnect).toHaveBeenCalledTimes(1);
  });

  test('Retry calls retryAutoConnect while haptics throw synchronously', async () => {
    mockHapticsMode.throws = true;
    await mount(createElement(OnboardingScreen));

    await act(async () => {
      press('Retry');
    });
    await settle();

    expect(mockGateway.retryAutoConnect).toHaveBeenCalledTimes(1);
  });

  test('the ErrorCard Try-again path still calls handleContinue', async () => {
    connectFails = true;
    await mount(createElement(OnboardingScreen));
    await act(async () => {
      press('Connect gateway');
    });
    await settle();
    mockGateway.setupFromPcAddress.mockClear();

    const card = renderer.root.findAllByType(ERROR_CARD)[0];
    await act(async () => {
      (card.props as { onRetry?: () => void }).onRetry?.();
    });
    await settle();

    expect(mockGateway.setupFromPcAddress).toHaveBeenCalled();
  });
});

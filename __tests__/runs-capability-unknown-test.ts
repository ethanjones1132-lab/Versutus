// An `agent` capability the gateway has not reported yet is not an empty run
// list.
//
// `buildCapabilitySnapshot` puts the `agent` group in `unknown` while the
// gateway is connected but no capability catalog has been read yet
// ("No capability catalog", dashboard.ts). The Runs screen judged only `ready`
// (supported) and `unsupported` (chat-only), so that third state fell through
// to the "No runs yet" empty state — the screen claimed the gateway had no runs
// when in truth nothing on this phone had asked it. These mount the real
// RunsScreen and pin the distinct variant: it says the run API has not been
// reported, names the gateway, and offers the screen's existing refresh. The
// ready, unsupported and disconnected variants stay byte-identical, and a
// gateway that does hold runs still lists them under an unknown snapshot.
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
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/components/layout/ComposerKeyboardLift', () => ({
  ComposerKeyboardLift: ({ children }: { children: unknown }) => children,
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
// The spend fold reads a catalogue over the wire; it is not what this test is
// about, and a real read would hold the screen on a gateway that does not exist.
jest.mock('@/lib/gateway/spend-report', () => ({
  readBotSpend: async () => ({ rows: [], degraded: false }),
}));

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

const gateway = (id: string) => ({
  id,
  name: 'Home PC',
  url: 'http://alpha.test:8642',
  token: 'tok',
  createdAt: 0,
});

/** A snapshot whose `agent` group is in the given state, or absent for null. */
function snapshotWith(agentStatus: GatewayCapabilityGroup['status'] | null): GatewayCapabilitySnapshot {
  return {
    checkedAt: 1_800_000_000_000,
    status: 'fresh',
    groups:
      agentStatus === null ? [] : [{ id: 'agent', label: 'Agent', status: agentStatus }],
    methods: {},
    scopes: [],
  };
}

const mockGateway = {
  activeGateway: gateway('gw-1') as unknown as Record<string, unknown>,
  status: 'connected',
  capabilitySnapshot: snapshotWith('ready'),
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
  cron: { available: true, list: jest.fn(async () => []) },
  listBots: jest.fn(async () => []),
  readBotSessions: jest.fn(async () => []),
  canReadBotSessions: true,
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import RunsScreen from '@/app/runs';
import type { ActivityRun } from '@/lib/gateway/runs';
import type {
  GatewayCapabilityGroup,
  GatewayCapabilitySnapshot,
} from '@/lib/gateway/types';

const EMPTY_STATE = 'EmptyState' as ElementType;
const RUN_CARD = 'RunCard' as ElementType;

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

type EmptyStateProps = {
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
};

/** Every EmptyState this screen is drawing, in tree order. */
function emptyStates(): EmptyStateProps[] {
  return renderer!.root
    .findAllByType(EMPTY_STATE)
    .map((node) => node.props as EmptyStateProps);
}

function run(id: string, status: ActivityRun['status'], startedAt: number): ActivityRun {
  return {
    id,
    prompt: id,
    status,
    startedAt,
    finishedAt: status === 'running' ? undefined : startedAt + 60_000,
    events: [],
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGateway.status = 'connected';
  mockGateway.activeGateway = gateway('gw-1');
  mockGateway.capabilitySnapshot = snapshotWith('ready');
  mockGateway.activityRunsForActiveGateway = [];
  mockGateway.refreshCapabilities.mockClear();
  mockGateway.refreshCapabilities.mockImplementation(async () => true);
  mockGateway.refreshGateways.mockClear();
  mockGateway.connectGateway.mockClear();
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

test('a connected gateway with an unknown agent capability names the unread snapshot', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('unknown');
  await mount();

  const states = emptyStates();
  expect(states).toHaveLength(1);
  const [state] = states;
  expect(state.title).toBe('Run API not reported yet');
  // The gateway is named, and the sentence says what is actually true: nothing
  // has asked it yet.
  expect(state.description).toBe(
    'Home PC has not reported whether it offers agentic runs yet. Refresh to ask it again.',
  );
  // The empty-list claim is gone, in either of its two shapes.
  expect(state.title).not.toBe('No runs yet');
  expect(state.description).not.toBe(
    'Start a run above, use Chat overflow → Run task, or type /run <prompt> in chat.',
  );
});

test('the unknown variant offers the screen\'s existing refresh', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('unknown');
  await mount();

  const [state] = emptyStates();
  expect(state.actionLabel).toBe('Refresh');
  expect(typeof state.onAction).toBe('function');

  // The same pull-to-refresh read: capabilities and gateways, once.
  await act(async () => {
    state.onAction!();
    await jest.advanceTimersByTimeAsync(500);
  });
  expect(mockGateway.refreshCapabilities).toHaveBeenCalledTimes(1);
  expect(mockGateway.refreshGateways).toHaveBeenCalledTimes(1);
});

test('a ready agent capability keeps today\'s "No runs yet" copy exactly', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('ready');
  await mount();

  const states = emptyStates();
  expect(states).toHaveLength(1);
  expect(states[0].title).toBe('No runs yet');
  expect(states[0].description).toBe(
    'Start a run above, use Chat overflow → Run task, or type /run <prompt> in chat.',
  );
  // No action of its own, exactly as before.
  expect(states[0].actionLabel).toBeUndefined();
});

test('an unsupported agent capability keeps "Runs not offered" byte-identical', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('unsupported');
  await mount();

  const states = emptyStates();
  expect(states).toHaveLength(1);
  expect(states[0].title).toBe('Runs not offered');
  expect(states[0].description).toBe(
    'Home PC is chat-only (or has no run API). Chat still works; agentic runs need Hermes /v1/runs.',
  );
  expect(states[0].actionLabel).toBeUndefined();
});

test('an unknown agent group while not connected keeps today\'s reconnect copy', async () => {
  // Offline, the screen is showing what this phone last saw; it must not claim
  // the gateway has not reported anything.
  mockGateway.status = 'disconnected';
  mockGateway.capabilitySnapshot = snapshotWith('unknown');
  await mount();

  const states = emptyStates();
  expect(states).toHaveLength(1);
  expect(states[0].title).toBe('Connect to start runs');
  expect(states[0].actionLabel).toBe('Reconnect');
});

test('an absent agent group keeps today\'s "No runs yet" copy', async () => {
  // Only the group the gateway reports as `unknown` is the unread-snapshot
  // variant; a snapshot with no agent group at all is not this step's claim.
  mockGateway.capabilitySnapshot = snapshotWith(null);
  await mount();

  const states = emptyStates();
  expect(states).toHaveLength(1);
  expect(states[0].title).toBe('No runs yet');
});

test('an unknown snapshot that does have runs still lists them', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('unknown');
  mockGateway.activityRunsForActiveGateway = [run('older-run', 'complete', 1)];
  await mount();

  expect(emptyStates()).toHaveLength(0);
  expect(renderer!.root.findAllByType(RUN_CARD)).toHaveLength(1);
});

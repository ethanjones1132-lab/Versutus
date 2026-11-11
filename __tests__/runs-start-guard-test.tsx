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
jest.mock('@/lib/gateway/spend-report', () => ({
  readBotSpend: async () => ({ rows: [], degraded: false }),
}));
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));
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

const gateway = () => ({
  id: 'gw-1',
  name: 'Home PC',
  url: 'http://alpha.test:8642',
  token: 'test-token',
  createdAt: 0,
});

const FAILED_RUN = {
  id: 'run-1',
  prompt: 'summarise the log',
  status: 'failed' as const,
  startedAt: 1,
  finishedAt: 2,
  events: [],
};

const mockGateway = {
  activeGateway: gateway() as unknown as Record<string, unknown>,
  status: 'connected',
  capabilitySnapshot: { status: 'fresh', groups: [{ id: 'agent', status: 'ready' }], methods: {} },
  activityRunsForActiveGateway: [] as unknown[],
  stopActivityRun: jest.fn(),
  connectGateway: jest.fn(async () => undefined),
  refreshCapabilities: jest.fn(async () => true),
  refreshGateways: jest.fn(async () => undefined),
  sendChatInput: jest.fn<Promise<string>, [string]>(async () => 'complete'),
  loadRunEvents: jest.fn(async () => []),
  requestedRunFocus: null,
  requestRunFocus: jest.fn(),
  clearRequestedRunFocus: jest.fn(),
  pendingApprovals: [] as unknown[],
  cron: { available: true, list: jest.fn(async () => []) },
  listBots: jest.fn(async () => []),
  readBotSessions: jest.fn(async () => []),
  canReadBotSessions: true,
};

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import RunsScreen from '@/app/runs';

const BUTTON = 'Button' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
const RUN_CARD = 'RunCard' as ElementType;
let renderer: ReactTestRenderer | null = null;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(RunsScreen));
  });
}

function button(label: string): { onPress?: () => void } {
  const found = renderer!.root.findAllByType(BUTTON).find((node) => node.props?.label === label);
  expect(found).toBeTruthy();
  return found!.props as { onPress?: () => void };
}

async function enterPrompt(prompt: string): Promise<void> {
  const field = renderer!.root
    .findAllByType(TEXT_FIELD)
    .find((node) => node.props?.accessibilityLabel === 'Run prompt');
  expect(field).toBeTruthy();
  await act(async () => {
    (field!.props.onChangeText as (value: string) => void)(prompt);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGateway.activeGateway = gateway();
  mockGateway.status = 'connected';
  mockGateway.capabilitySnapshot = {
    status: 'fresh',
    groups: [{ id: 'agent', status: 'ready' }],
    methods: {},
  };
  mockGateway.activityRunsForActiveGateway = [];
  mockGateway.sendChatInput.mockClear();
  mockGateway.sendChatInput.mockImplementation(async () => 'complete');
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => doomed.unmount());
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('two Start presses in one turn send once, and Start works again after the send settles', async () => {
  let releaseSend: ((outcome: string) => void) | undefined;
  mockGateway.sendChatInput.mockImplementation(
    () => new Promise<string>((resolve) => {
      releaseSend = resolve;
    }),
  );
  await mount();
  await enterPrompt('first task');
  const start = button('Run task').onPress!;

  await act(async () => {
    start();
    start();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mockGateway.sendChatInput).toHaveBeenCalledTimes(1);
  expect(mockGateway.sendChatInput).toHaveBeenCalledWith('/run first task');

  await act(async () => {
    releaseSend!('complete');
    await Promise.resolve();
  });
  mockGateway.sendChatInput.mockImplementation(async () => 'complete');
  await enterPrompt('second task');
  await act(async () => {
    button('Run task').onPress!();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockGateway.sendChatInput).toHaveBeenCalledTimes(2);
  expect(mockGateway.sendChatInput).toHaveBeenLastCalledWith('/run second task');
});

test.each(['unsupported', 'unknown'] as const)(
  'a failed run on a connected gateway with an %s agent capability has no Retry run action',
  async (agentStatus) => {
    mockGateway.capabilitySnapshot = {
      status: 'fresh',
      groups: [{ id: 'agent', status: agentStatus }],
      methods: {},
    };
    mockGateway.activityRunsForActiveGateway = [FAILED_RUN];
    await mount();

    expect(renderer!.root.findAllByType(RUN_CARD)).toHaveLength(1);
    expect((renderer!.root.findByType(RUN_CARD).props as { onRetry?: unknown }).onRetry).toBeUndefined();
    expect(mockGateway.sendChatInput).not.toHaveBeenCalled();
  },
);

test('a failed run with a ready agent capability offers Retry run and sends one /run', async () => {
  mockGateway.activityRunsForActiveGateway = [FAILED_RUN];
  await mount();
  const card = renderer!.root.findByType(RUN_CARD);
  const onRetry = (card.props as { onRetry?: (prompt: string) => void }).onRetry;

  expect(typeof onRetry).toBe('function');
  await act(async () => {
    onRetry!('summarise the log');
    await Promise.resolve();
  });

  expect(mockGateway.sendChatInput).toHaveBeenCalledTimes(1);
  expect(mockGateway.sendChatInput).toHaveBeenCalledWith('/run summarise the log');
});

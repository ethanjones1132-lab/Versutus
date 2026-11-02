/**
 * VS-042 — a Retry that succeeds is a Connect.
 *
 * The failed auto-connect's Retry re-runs the provider's discovery + probe +
 * connect ladder. When that ladder recovered the connection, the phase was
 * committed to 'connected' and… nothing happened: the operator sat on the
 * onboarding screen with no failure card and no way forward, which reads
 * exactly like a Retry that did nothing. The screen now judges the retry's
 * committed phase for BOTH outcomes — `failed` still names itself in the error
 * card, and `connected` lands on the Chat tab the way the typed Connect does,
 * once, with the retry state cleared afterwards.
 *
 * The phase is written the way the provider writes it: `retryAutoConnect`
 * parks the phase in 'searching' before its first await, and the verdict is
 * only committed later, so a read taken where the `await` returns is stale.
 * That is why these tests move the fixture through the same steps.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// A stable router, because the landing is asserted by call count: a fresh
// object per render would hide a second `replace` behind a new spy.
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
  SafeAreaView: 'SafeAreaView',
}));
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#0af',
    accentMuted: '#00f2',
    backgroundInset: '#111',
    border: '#333',
    borderSubtle: '#222',
    borderSubtleSolid: '#222',
    textPrimary: '#fff',
    textTertiary: '#777',
    statusConnected: '#0f0',
  }),
}));
jest.mock('@/hooks/use-now', () => ({ useNow: () => Date.now() }));
// Haptics are not the subject here, and the landing must not depend on a
// native module being present in the test host.
jest.mock('@/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(async () => undefined),
    light: jest.fn(async () => undefined),
    medium: jest.fn(async () => undefined),
    success: jest.fn(async () => undefined),
    warning: jest.fn(async () => undefined),
    error: jest.fn(async () => undefined),
  },
}));
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
      sin: (fn: unknown) => fn,
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
jest.mock('@/components/brand', () => ({ VersutusLogotype: 'VersutusLogotype' }));
jest.mock('@/components/connection-timeline', () => ({
  ConnectionTimeline: 'ConnectionTimeline',
  CONNECTION_TIMELINE_STEPS_LONG: [],
}));
jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  Screen: 'Screen',
  Text: 'Text',
  TextField: 'TextField',
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';

const BUTTON = 'Button' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;
const CHAT_TAB = '/(tabs)/chat';

const mockGateway = {
  setupFromPcAddress: jest.fn<Promise<{ kind: string }>, [string, string]>(async () => ({
    kind: 'unreachable',
  })),
  probeMessage: 'no gateway found',
  connectionPhase: 'failed' as string,
  settings: { tailscaleHost: '' },
  retryAutoConnect: jest.fn<Promise<void>, []>(async () => undefined),
};

let renderer: ReactTestRenderer;

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(OnboardingScreen));
  });
  await settle();
}

async function unmount(): Promise<void> {
  const doomed = renderer;
  renderer = undefined as unknown as ReactTestRenderer;
  await act(async () => {
    doomed.unmount();
  });
}

/**
 * Commits a phase the way the provider does. `useGateway` hands the screen the
 * live fixture, so writing the phase and re-rendering is the only honest way
 * to show the screen the phase a real `connectionPhase` change would have
 * produced.
 */
async function commitPhase(phase: string): Promise<void> {
  mockGateway.connectionPhase = phase;
  await act(async () => {
    renderer.update(createElement(OnboardingScreen));
  });
  await settle();
}

type ButtonProps = { label: string; onPress?: () => void; disabled?: boolean };

function buttons(): ButtonProps[] {
  return renderer.root.findAllByType(BUTTON).map((node) => node.props as ButtonProps);
}

function button(label: string): ButtonProps | undefined {
  return buttons().find((node) => node.label === label);
}

/**
 * What `retryAutoConnect` really does: `runAutoConnect` commits 'searching'
 * before its first await, and the ladder's own verdict is committed before it
 * resolves. `openCycle` is the end of that run.
 */
function pendingCycle(phaseWhenDone: string): () => void {
  let openCycle!: () => void;
  mockGateway.retryAutoConnect.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        mockGateway.connectionPhase = 'searching';
        openCycle = () => {
          mockGateway.connectionPhase = phaseWhenDone;
          resolve();
        };
      }),
  );
  return () => openCycle();
}

/** Runs a retry from the failed screen up to the point its ladder ends. */
async function startRetry(): Promise<void> {
  await act(async () => {
    button('Retry')?.onPress?.();
  });
  await settle();
  await commitPhase('searching');
}

beforeEach(() => {
  mockGateway.probeMessage = 'no gateway found';
  mockGateway.connectionPhase = 'failed';
  mockGateway.settings = { tailscaleHost: '' };
  mockGateway.retryAutoConnect.mockClear();
  mockGateway.retryAutoConnect.mockImplementation(async () => undefined);
  mockGateway.setupFromPcAddress.mockClear();
  mockRouter.replace.mockClear();
  mockRouter.push.mockClear();
  mockRouter.back.mockClear();
});

afterEach(async () => {
  if (renderer) await unmount();
});

describe('VS-042: a retry that succeeds takes the operator into the app', () => {
  test('a connected verdict replaces the route with the chat tab exactly once and leaves no failure card', async () => {
    const openCycle = pendingCycle('connected');
    await mount();

    await startRetry();
    // The ladder is still running: a landing here would take the operator off
    // a screen that has not yet been told the gateway is up.
    expect(mockRouter.replace).not.toHaveBeenCalled();

    await act(async () => {
      openCycle();
    });
    await settle();
    await commitPhase('connected');

    // Landing is what the typed Connect does, and it happens once.
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(CHAT_TAB);
    // A successful retry is a connect, not a failure: no error card, and no
    // Retry left behind to imply the cycle did not take.
    expect(renderer.root.findAllByType(ERROR_CARD)).toHaveLength(0);
    expect(button('Retry')).toBeUndefined();
    expect(button('Retrying…')).toBeUndefined();

    // The retry state is cleared with the verdict: further phase churn on the
    // same screen must not stack a second chat entry on the router.
    await commitPhase('connected');
    await commitPhase('searching');
    await commitPhase('connected');
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  test('a later mount does not re-navigate from a spent retry', async () => {
    const openCycle = pendingCycle('connected');
    await mount();
    await startRetry();
    await act(async () => {
      openCycle();
    });
    await settle();
    await commitPhase('connected');
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);

    // Re-mounting while the gateway is connected is the app's problem to route
    // (the boot guard), not a retry's: the retry state was cleared, not kept.
    await unmount();
    await mount();
    await commitPhase('connected');

    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  test('a failed verdict still shows the failure card and never navigates', async () => {
    const openCycle = pendingCycle('failed');
    await mount();
    expect(renderer.root.findAllByType(ERROR_CARD)).toHaveLength(0);

    await startRetry();
    await act(async () => {
      openCycle();
    });
    await settle();
    await commitPhase('failed');

    // The retry's own answer replaces the words from before the tap.
    const cards = renderer.root.findAllByType(ERROR_CARD);
    expect(cards).toHaveLength(1);
    expect(cards[0].props.cause).toBe('no gateway found');
    expect(cards[0].props.affected).toBe('gateway connection');
    // A retry that failed again keeps the operator on the screen that can ask
    // for an address, and does not pretend the journey is over.
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(button('Retry')?.disabled).toBeFalsy();
  });
});

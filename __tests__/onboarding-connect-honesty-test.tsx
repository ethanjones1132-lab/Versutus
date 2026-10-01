/**
 * ONB-1 and ONB-2, at the one surface the operator can reach both from.
 *
 * ONB-1: the Retry button fired `void retryAutoConnect()` — a cycle with no
 * `catch` inside it — with no busy state and no result, so a retry that ended
 * in `failed` again looked exactly like the screen before the tap.
 *
 * ONB-2: the address field validated the HOST and stripped the port, so
 * `100.95.137.83:99999` read "ready" and Connect was enabled — for an address
 * `new URL` refuses, which the candidate builder then dropped silently on
 * every wave.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
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
const TEXT_FIELD = 'TextField' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;
const TEXT = 'Text' as ElementType;

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

/**
 * Commits a phase the way the provider does. `useGateway` hands the screen the
 * live fixture, so writing the phase and re-rendering is the only honest way
 * to show the screen the phase a real `connectionPhase` change would have
 * produced — a fixture that only ever says 'failed' hides a busy-gated button.
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

function texts(): string {
  return renderer.root
    .findAllByType(TEXT)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

async function typeAddress(value: string): Promise<void> {
  const field = renderer.root.findAllByType(TEXT_FIELD).find(
    (node) => typeof node.props?.placeholder === 'string' && node.props.placeholder.endsWith('ts.net'),
  );
  if (!field) throw new Error('the PC address field is not on screen');
  await act(async () => {
    (field.props as { onChangeText: (next: string) => void }).onChangeText(value);
  });
  await settle();
}

beforeEach(() => {
  mockGateway.probeMessage = 'no gateway found';
  mockGateway.connectionPhase = 'failed';
  mockGateway.settings = { tailscaleHost: '' };
  mockGateway.retryAutoConnect.mockClear();
  mockGateway.retryAutoConnect.mockImplementation(async () => undefined);
  mockGateway.setupFromPcAddress.mockClear();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
});

describe('ONB-1: the failed auto-connect Retry is honest about its own run', () => {
  /**
   * What `retryAutoConnect` really does: `runAutoConnect` commits 'searching'
   * before its first await (gateway-provider.tsx:2373), which is what makes
   * `busy` true for the whole ladder. Every test below gets that phase, so a
   * busy-gated Retry button cannot pass by hiding.
   */
  function pendingCycle(phaseWhenDone: string) {
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

  test('the button says it is working through the whole searching phase, and is disabled', async () => {
    const openCycle = pendingCycle('failed');
    await mount();
    expect(button('Retry')).toBeTruthy();

    await act(async () => {
      button('Retry')?.onPress?.();
    });
    await settle();
    await commitPhase('searching');

    // The ladder is parked in 'searching', so `busy` is true for its whole
    // run: the tap has to stay visible, or an unchanged screen over a 30s
    // probe ladder is indistinguishable from a dead button.
    expect(button('Retry')).toBeUndefined();
    expect(button('Retrying…')).toMatchObject({ disabled: true });
    expect(mockGateway.retryAutoConnect).toHaveBeenCalledTimes(1);

    // A second tap inside the run must not start a second ladder. `disabled`
    // is only a hint the real Button honours; the ref is the guard.
    await act(async () => {
      button('Retrying…')?.onPress?.();
    });
    await settle();
    expect(mockGateway.retryAutoConnect).toHaveBeenCalledTimes(1);
    expect(button('Retrying…')).toMatchObject({ disabled: true });

    // The ladder ends in `failed` again: an enabled Retry is back.
    await act(async () => {
      openCycle();
    });
    await settle();
    await commitPhase('failed');

    expect(button('Retrying…')).toBeUndefined();
    expect(button('Retry')?.disabled).toBeFalsy();
  });

  test('a second tap inside one frame runs one cycle, not two', async () => {
    await mount();

    // Both taps come off the SAME rendered closure, which is exactly the frame
    // a nervous second tap lands in: `setRetrying` cannot gate it.
    await act(async () => {
      button('Retry')?.onPress?.();
      button('Retry')?.onPress?.();
    });
    await settle();

    expect(mockGateway.retryAutoConnect).toHaveBeenCalledTimes(1);
  });

  test('a cycle that ends in failed names itself instead of reusing the old probe line', async () => {
    const openCycle = pendingCycle('failed');
    await mount();
    // The message on screen is from BEFORE the tap, and it is all the operator
    // would have seen, so it is not evidence anything happened.
    expect(texts()).toContain('no gateway found');

    await act(async () => {
      button('Retry')?.onPress?.();
    });
    await settle();
    await commitPhase('searching');

    // The ladder's own answer replaces the line from before the tap — which
    // the busy phase has hidden the whole run, so it cannot be read off the
    // status card on the way back down.
    mockGateway.probeMessage = 'Saved your address, but could not reach the gateway.';
    await act(async () => {
      openCycle();
    });
    await settle();
    await commitPhase('failed');

    const cards = renderer.root.findAllByType(ERROR_CARD);
    expect(cards).toHaveLength(1);
    expect(cards[0].props.cause).toBe('Saved your address, but could not reach the gateway.');
    expect(cards[0].props.affected).toBe('gateway connection');
  });

  test('a cycle that succeeds leaves no failure card and no Retry behind', async () => {
    const openCycle = pendingCycle('connected');
    await mount();
    await act(async () => {
      button('Retry')?.onPress?.();
    });
    await settle();
    await commitPhase('searching');
    expect(button('Retrying…')).toMatchObject({ disabled: true });

    await act(async () => {
      openCycle();
    });
    await settle();
    await commitPhase('connected');

    expect(renderer.root.findAllByType(ERROR_CARD)).toHaveLength(0);
    expect(button('Retry')).toBeUndefined();
    expect(button('Retrying…')).toBeUndefined();
  });

  test('a rejected cycle is handled and named, and stops claiming to be retrying', async () => {
    mockGateway.retryAutoConnect.mockImplementationOnce(async () => {
      // `runAutoConnect` parks the phase in 'searching' and its `finally`
      // only clears the in-flight flag, so a throwing cycle leaves it there.
      mockGateway.connectionPhase = 'searching';
      throw new Error('the cycle exploded');
    });
    await mount();
    await act(async () => {
      button('Retry')?.onPress?.();
    });
    await settle();

    // The handler owns the rejection, so the cycle's own failure never becomes
    // an unhandled one and it is named instead of dropped.
    expect(renderer.root.findAllByType(ERROR_CARD)[0]?.props.cause).toBe('the cycle exploded');
    expect(button('Retrying…')).toBeUndefined();
    expect(mockGateway.retryAutoConnect).toHaveBeenCalledTimes(1);

    // Whenever the phase is back in the failed phase, the button is there and
    // enabled again — the throw cannot leave it wedged.
    await commitPhase('failed');
    expect(button('Retry')?.disabled).toBeFalsy();
  });
});

describe('ONB-2: a port no socket can be asked for never reads "ready"', () => {
  test.each([
    ['100.95.137.83:99999', 'above the URL parser ceiling'],
    ['100.95.137.83:65536', 'one past the ceiling'],
    ['100.95.137.83:0', 'port zero'],
  ])('%s is refused before it can be saved (%s)', async (address) => {
    await mount();
    await typeAddress(address);

    expect(texts()).toContain('Ports go from 1 to 65535.');
    expect(button('Connect gateway')?.disabled).toBe(true);
    expect(mockGateway.setupFromPcAddress).not.toHaveBeenCalled();
  });

  test.each(['100.95.137.83:1', '100.95.137.83:65535', '100.95.137.83'])(
    '%s stays a usable address',
    async (address) => {
      await mount();
      await typeAddress(address);

      expect(texts()).toContain('Looks good');
      expect(button('Connect gateway')?.disabled).toBeFalsy();
    },
  );
});

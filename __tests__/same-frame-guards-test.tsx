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
jest.mock('@/components/connection-timeline', () => ({ ConnectionTimeline: 'ConnectionTimeline', CONNECTION_TIMELINE_STEPS_LONG: [] }));
jest.mock('@/components/ui', () => ({
  ActivityIndicator: 'ActivityIndicator', Badge: 'Badge', Button: 'Button', Card: 'Card', EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard', ListRow: 'ListRow', Screen: 'Screen', Skeleton: 'Skeleton', Text: 'Text', TextField: 'TextField',
}));
jest.mock('@/components/activity/cron-job-sheet', () => ({ CronJobSheet: 'CronJobSheet' }));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));
jest.mock('@/hooks/use-tokens', () => ({ useTokens: () => ({ accent: '#0af', accentMuted: '#00f2', backgroundInset: '#111', border: '#333', borderSubtle: '#222', statusConnected: '#0f0' }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }), useFocusEffect: (effect: () => void) => { const { useEffect } = jest.requireActual<typeof import('react')>('react'); useEffect(effect, [effect]); } }));

const mockGateway = {
  setupFromPcAddress: jest.fn<Promise<{ kind: string }>, [string, string]>(),
  retryAutoConnect: jest.fn(async () => undefined),
  probeMessage: null as string | null,
  connectionPhase: 'idle',
  settings: { tailscaleHost: '' },
  status: 'connected',
  cron: { available: true, list: jest.fn(async () => []) },
  botJobs: { create: jest.fn<Promise<unknown>, [unknown]>() },
};
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));
jest.mock('@/lib/notifications/routine-sync', () => ({ syncRoutineNotification: jest.fn(), cancelRoutineNotification: jest.fn() }));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { CronSection } from '@/components/activity/cron-section';
import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';

const BUTTON = 'Button' as ElementType;
const FIELD = 'TextField' as ElementType;
let renderer: ReactTestRenderer | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function button(label: string): ReactTestInstance {
  const found = renderer?.root.findAllByType(BUTTON).find((item) => item.props.label === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}

afterEach(async () => {
  if (renderer) {
    const old = renderer;
    renderer = null;
    await act(async () => old.unmount());
  }
  mockGateway.setupFromPcAddress.mockReset();
  mockGateway.botJobs.create.mockReset();
});

test('Connect ignores same-frame duplicates and is available after settling', async () => {
  const first = deferred<{ kind: string }>();
  mockGateway.setupFromPcAddress.mockReturnValueOnce(first.promise).mockResolvedValue({ kind: 'unreachable' });
  await act(async () => { renderer = create(createElement(OnboardingScreen)); });
  const address = renderer!.root.findAllByType(FIELD).find((item) => String(item.props.placeholder).endsWith('ts.net'));
  await act(async () => address?.props.onChangeText('my-pc.tailnet.ts.net'));
  await act(async () => {
    button('Connect your PC').props.onPress();
    button('Connect your PC').props.onPress();
  });
  expect(mockGateway.setupFromPcAddress).toHaveBeenCalledTimes(1);
  await act(async () => { first.resolve({ kind: 'unreachable' }); await first.promise; });
  await act(async () => button('Connect your PC').props.onPress());
  expect(mockGateway.setupFromPcAddress).toHaveBeenCalledTimes(2);
});

test('Add ignores same-frame duplicates and is available after rejection', async () => {
  const first = deferred<unknown>();
  mockGateway.botJobs.create.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('refused'));
  await act(async () => { renderer = create(createElement(CronSection, { showList: false })); });
  const fields = renderer!.root.findAllByType(FIELD);
  await act(async () => {
    fields[0]?.props.onChangeText('Overnight');
    fields[1]?.props.onChangeText('0 9 * * *');
    fields[2]?.props.onChangeText('Summarize mail');
  });
  await act(async () => {
    button('Add').props.onPress();
    button('Add').props.onPress();
  });
  expect(mockGateway.botJobs.create).toHaveBeenCalledTimes(1);
  await act(async () => { first.reject(new Error('refused')); await first.promise.catch(() => undefined); });
  await act(async () => button('Add').props.onPress());
  expect(mockGateway.botJobs.create).toHaveBeenCalledTimes(2);
});

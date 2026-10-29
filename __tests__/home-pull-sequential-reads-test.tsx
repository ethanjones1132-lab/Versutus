// VS-004 — one pull-to-refresh on Home used to read all three of its gateway
// sources at once: `Promise.all([refreshCapabilities(), refreshGateways(),
// reloadHistory()])` against a host the repo documents as serving one request
// at a time, so the spinner waited on contention rather than on the work.
// Activity's pull was already changed to read in series for the same reason
// (__tests__/activity-pull-sequential-reads-test.tsx); these mount the real
// HomeScreen and pin the same order, one read per stage, and that a refused
// stage still names itself, still holds the spinner, and still recovers on
// Retry/Dismiss.
//
// Each stage's promise is parked by the test, so "the roster has not started"
// is an observed fact rather than a timing coincidence: reverting Home to the
// fan-out puts all three `:start` markers on the trace before anything settles
// and fails the first test.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  ErrorCard: 'ErrorCard',
  PageTitle: 'PageTitle',
  Screen: 'Screen',
  ScreenHeader: 'ScreenHeader',
  Text: 'Text',
}));

// The dashboard is the residual surface, not what this test is about; it reads
// the provider through many more fields than a refresh needs.
jest.mock('@/components/gateway/gateway-home-dashboard', () => ({
  GatewayHomeDashboard: 'GatewayHomeDashboard',
}));
jest.mock('@/components/nav/drawer-menu-button', () => ({ DrawerMenuButton: 'DrawerMenuButton' }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: () => undefined }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/lib/motion/ambient-parallax', () => ({
  useAmbientParallaxScroll: () => ({ parallaxY: 0, onScroll: () => undefined }),
}));

jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({ accent: '#5b8def', backgroundElevated: '#101216' }),
}));

type Stage = 'capabilities' | 'gateways' | 'history';

/** Every read the pull issued, as `stage:start` / `stage:settled` markers. */
const trace: string[] = [];
const calls: Record<Stage, number> = { capabilities: 0, gateways: 0, history: 0 };

type Deferred = {
  resolve: () => void;
  reject: (reason: unknown) => void;
};

const parked: Record<Stage, Deferred[]> = { capabilities: [], gateways: [], history: [] };

/** One read the test holds open until it says otherwise. */
function stage(name: Stage): Promise<void> {
  trace.push(`${name}:start`);
  calls[name] += 1;
  let answer!: () => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    answer = () => resolve();
    fail = (reason) => reject(reason);
  });
  parked[name].push({ resolve: answer, reject: fail });
  return promise;
}

const mockGateway = {
  gateways: [] as { id: string }[],
  status: 'connected',
  refreshCapabilities: () => stage('capabilities'),
  refreshGateways: () => stage('gateways'),
  reloadHistory: () => stage('history'),
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

import { createElement, type ElementType } from 'react';
import { RefreshControl } from 'react-native';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import HomeScreen from '@/app/(tabs)/home';

let renderer: ReactTestRenderer | null = null;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(HomeScreen));
  });
  // One tick, like the Activity pull test: let any mount-time effect settle
  // before the test counts reads (Home reads nothing on arrival).
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

/** The pull itself: Home hands RefreshControl `() => void onRefresh()`. */
async function pull(): Promise<void> {
  const control = renderer?.root.findByType(RefreshControl);
  expect(control).toBeDefined();
  await act(async () => {
    control?.props.onRefresh();
  });
}

/** Answer one parked read and let the screen react to it. */
async function settle(name: Stage): Promise<void> {
  const next = parked[name].shift();
  expect(next).toBeDefined();
  await act(async () => {
    trace.push(`${name}:settled`);
    next!.resolve();
    await jest.advanceTimersByTimeAsync(1);
  });
}

/** Refuse one parked read, as a gateway that answered with an error would. */
async function refuse(name: Stage, message: string): Promise<void> {
  const next = parked[name].shift();
  expect(next).toBeDefined();
  await act(async () => {
    trace.push(`${name}:refused`);
    next!.reject(new Error(message));
    await jest.advanceTimersByTimeAsync(1);
  });
}

/** Run out the 400 ms minimum spinner hold. */
async function finishHold(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(400);
  });
}

function spinner(): boolean | undefined {
  return renderer?.root.findByType(RefreshControl).props.refreshing;
}

function errorCards(): ReactTestInstance[] {
  return renderer?.root.findAllByType('ErrorCard' as ElementType) ?? [];
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_700_000_000_000);
  trace.length = 0;
  calls.capabilities = 0;
  calls.gateways = 0;
  calls.history = 0;
  parked.capabilities.length = 0;
  parked.gateways.length = 0;
  parked.history.length = 0;
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

test('a pull reads the capabilities, then the roster, then the history — one at a time', async () => {
  await mount();
  // Arriving on Home reads nothing; the pull is the only trigger.
  expect(calls).toEqual({ capabilities: 0, gateways: 0, history: 0 });

  await pull();

  // Only the first read is out. A `Promise.all` would have all three in flight
  // here, which is the contention VS-004 names.
  expect(trace).toEqual(['capabilities:start']);
  expect(calls).toEqual({ capabilities: 1, gateways: 0, history: 0 });

  await settle('capabilities');
  expect(trace).toEqual(['capabilities:start', 'capabilities:settled', 'gateways:start']);
  expect(calls.history).toBe(0);

  await settle('gateways');
  expect(trace).toEqual([
    'capabilities:start',
    'capabilities:settled',
    'gateways:start',
    'gateways:settled',
    'history:start',
  ]);

  await settle('history');
  await finishHold();

  // One read each, in that order: the pull costs three requests, not a pile.
  expect(calls).toEqual({ capabilities: 1, gateways: 1, history: 1 });
});

test('the spinner spans every stage and holds to the 400 ms floor', async () => {
  await mount();
  await pull();
  expect(spinner()).toBe(true);

  await settle('capabilities');
  expect(spinner()).toBe(true);

  await settle('gateways');
  expect(spinner()).toBe(true);

  await settle('history');
  await finishHold();
  expect(spinner()).toBe(false);
});

test('a refused stage is named on screen and the later stages are not read behind it', async () => {
  await mount();
  await pull();
  await refuse('capabilities', 'the gate refused the capability read');

  const notice = errorCards();
  expect(notice).toHaveLength(1);
  expect(notice[0].props.cause).toBe('the gate refused the capability read');

  // The serial pull stops at the refusal: nothing was piled on behind it.
  expect(trace).toEqual(['capabilities:start', 'capabilities:refused']);
  expect(calls).toEqual({ capabilities: 1, gateways: 0, history: 0 });

  // A refusal still pays the minimum hold rather than flashing the spinner off.
  expect(spinner()).toBe(true);
  await finishHold();
  expect(spinner()).toBe(false);
  // The notice stays until the operator retries or dismisses it.
  expect(errorCards()).toHaveLength(1);
});

test('Retry re-reads the three stages in order and clears the notice on success', async () => {
  await mount();
  await pull();
  await refuse('capabilities', 'the gate refused the capability read');
  await finishHold();

  const retry = errorCards()[0].props.onRetry as () => void;
  await act(async () => {
    retry();
  });

  // Retry runs the same serial pull, not a parallel one.
  expect(trace.slice(-1)).toEqual(['capabilities:start']);
  expect(calls).toEqual({ capabilities: 2, gateways: 0, history: 0 });

  await settle('capabilities');
  await settle('gateways');
  // Still up: the notice clears only once the whole pull succeeds.
  expect(errorCards()).toHaveLength(1);

  await settle('history');
  expect(errorCards()).toHaveLength(0);
  expect(calls).toEqual({ capabilities: 2, gateways: 1, history: 1 });

  await finishHold();
  expect(spinner()).toBe(false);
});

test('Dismiss clears the notice without issuing another read', async () => {
  await mount();
  await pull();
  await refuse('capabilities', 'the gate refused the capability read');
  await finishHold();
  expect(errorCards()).toHaveLength(1);

  const dismiss = errorCards()[0].props.onDismiss as () => void;
  await act(async () => {
    dismiss();
  });

  expect(errorCards()).toHaveLength(0);
  expect(calls).toEqual({ capabilities: 1, gateways: 0, history: 0 });
});

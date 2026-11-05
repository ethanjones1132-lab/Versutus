jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/ui', () => ({ Text: 'Text' }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    backgroundRaised: '#111',
    statusConnectedMuted: '#222',
    overlay: '#000',
    statusConnected: '#0f0',
  }),
}));

const mockGateway = {
  status: 'disconnected' as string,
  activeGateway: { name: 'Studio' } as { name: string } | null,
  activeHello: { server: { version: '1.0' } } as { server: { version: string } } | null,
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

import { createElement } from 'react';
import { View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ConnectedToast } from '@/components/connected-toast';

let renderer: ReactTestRenderer | null = null;

function toastHost() {
  return renderer?.root.findByType(View);
}

async function updateGateway(patch: Partial<typeof mockGateway>) {
  Object.assign(mockGateway, patch);
  await act(async () => {
    renderer?.update(createElement(ConnectedToast));
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  Object.assign(mockGateway, {
    status: 'disconnected',
    activeGateway: { name: 'Studio' },
    activeHello: { server: { version: '1.0' } },
  });
});

afterEach(async () => {
  if (renderer) {
    const mounted = renderer;
    renderer = null;
    await act(async () => mounted.unmount());
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function mount() {
  await act(async () => {
    renderer = create(createElement(ConnectedToast));
  });
}

test('stays silent when first mounted already connected', async () => {
  mockGateway.status = 'connected';
  await mount();
  expect(toastHost()?.props.accessibilityElementsHidden).toBe(true);
});

test('retires immediately on disconnect and celebrates a later reconnect', async () => {
  await mount();
  await updateGateway({ status: 'connected' });
  expect(toastHost()?.props.accessibilityElementsHidden).toBe(false);

  await updateGateway({ status: 'disconnected' });
  expect(toastHost()?.props.accessibilityElementsHidden).toBe(true);

  await updateGateway({ status: 'connected' });
  expect(toastHost()?.props.accessibilityElementsHidden).toBe(false);
});

test('metadata identity churn does not restart the original two-second hold', async () => {
  await mount();
  await updateGateway({ status: 'connected' });
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });

  await updateGateway({
    activeGateway: { name: 'Studio renamed' },
    activeHello: { server: { version: '2.0' } },
  });
  await act(async () => {
    jest.advanceTimersByTime(500);
  });

  expect(toastHost()?.props.accessibilityElementsHidden).toBe(true);
});

test('normal expiry and unmount both leave no hide timer behind', async () => {
  await mount();
  const ambientTimers = jest.getTimerCount();
  await updateGateway({ status: 'connected' });
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(toastHost()?.props.accessibilityElementsHidden).toBe(true);
  expect(jest.getTimerCount()).toBe(ambientTimers);

  await updateGateway({ status: 'disconnected' });
  await updateGateway({ status: 'connected' });
  expect(toastHost()?.props.accessibilityElementsHidden).toBe(false);
  const mounted = renderer;
  renderer = null;
  await act(async () => mounted?.unmount());
});

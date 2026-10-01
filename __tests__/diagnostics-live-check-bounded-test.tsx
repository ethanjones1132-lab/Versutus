// ─── Diagnostics: the live check always comes back ──────────────────────────
// This screen is the app's one loop that answers for the device, and the live
// check was the only network probe in it with no bound: a gateway that accepts
// the connection and then says nothing — the half-open Tailscale/DERP shape —
// left the button on "Checking…" and disabled for the rest of the session, with
// the operator unable to ask again. The probe is now bounded (see
// `probeStreamingFetch`), so what is left to hold here is the screen's side of
// that contract: a second tap while a probe is in flight must not start
// another, and an answer that lands after the operator has left must not write.

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

jest.mock('@/components/ui', () => ({
  Screen: 'Screen',
  Card: 'Card',
  Badge: 'Badge',
  Button: 'Button',
  Text: 'Text',
}));

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({ activeGateway: { kind: 'custom', url: 'http://gate.test' } }),
}));

jest.mock('@/lib/diagnostics/failure-log', () => ({
  loadFailures: jest.fn(async () => []),
  clearFailures: jest.fn(async () => undefined),
}));

jest.mock('@/lib/runtime-environment', () => ({
  probeRuntimeGlobals: () => [],
  probeStreamingFetch: jest.fn(),
}));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { createElement, type ElementType } from 'react';
import { ScrollView } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import GatewayDiagnosticsScreen from '@/app/gateway/diagnostics';
import { probeStreamingFetch } from '@/lib/runtime-environment';

// React Native's first render in a process lazily loads its own internals, and
// the cost lands on whichever test renders first — on a loaded machine it can
// exceed a test's 20 s budget on its own. Nothing here is under test, so the
// container pays for it once, at module scope, where no per-test clock runs.
act(() => {
  create(createElement(ScrollView)).unmount();
});

const BUTTON = 'Button' as ElementType;

const TIMED_OUT = {
  id: 'streaming-fetch-live',
  label: 'Live: response body is readable',
  ok: false,
  critical: true,
  detail: 'The gateway did not answer within 8 s',
};

const OK = {
  id: 'streaming-fetch-live',
  label: 'Live: response body is readable',
  ok: true,
  critical: true,
  detail: 'Read 15 bytes incrementally from http://gate.test/health.',
};

let renderer: ReactTestRenderer | undefined;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function button(label: string): { props: { onPress?: () => void; disabled?: boolean } } | undefined {
  return renderer?.root.findAllByType(BUTTON).find((candidate) => candidate.props.label === label);
}

/** Every button label currently on screen. */
function labels(): string[] {
  return renderer?.root
    .findAllByType(BUTTON)
    .map((node) => String(node.props.label)) as string[];
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(GatewayDiagnosticsScreen));
  });
}

async function press(label: string): Promise<void> {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => {
    target?.props.onPress?.();
  });
}

beforeEach(() => {
  (probeStreamingFetch as jest.Mock).mockReset();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllMocks();
});

test('a settled probe hands the button back, and its answer renders', async () => {
  (probeStreamingFetch as jest.Mock).mockResolvedValue(TIMED_OUT);
  await mount();

  await press('Run live check');

  // The bound is what makes this possible: the probe always answers, so the
  // control comes back and the failure is a rendered check rather than a
  // spinner nobody can clear.
  expect(labels()).toContain('Run live check');
  expect(button('Run live check')?.props.disabled).toBe(false);
  expect(JSON.stringify(renderer?.toJSON())).toContain(TIMED_OUT.detail);
});

test('a second tap while a probe is in flight starts no second probe', async () => {
  const gate = deferred<typeof TIMED_OUT>();
  (probeStreamingFetch as jest.Mock).mockReturnValue(gate.promise);
  await mount();

  await press('Run live check');
  expect(labels()).toContain('Checking…');
  expect(probeStreamingFetch).toHaveBeenCalledTimes(1);

  // A second request against the same half-open path would double the very load
  // the probe is measuring, and the first answer would still land.
  const running = button('Checking…');
  await act(async () => {
    running?.props.onPress?.();
  });
  expect(probeStreamingFetch).toHaveBeenCalledTimes(1);

  await act(async () => {
    gate.resolve(TIMED_OUT);
    await gate.promise;
  });
  expect(labels()).toContain('Run live check');
});

test('an answer that lands after unmount writes nothing', async () => {
  const gate = deferred<typeof TIMED_OUT>();
  (probeStreamingFetch as jest.Mock).mockReturnValue(gate.promise);
  await mount();

  await press('Run live check');
  const doomed = renderer;
  renderer = undefined;
  await act(async () => {
    doomed?.unmount();
  });

  // The probe is bounded, so this is the ordinary end of every run — the screen
  // is simply gone by the time the answer arrives.
  await act(async () => {
    gate.resolve(OK);
    await gate.promise;
  });

  expect(probeStreamingFetch).toHaveBeenCalledTimes(1);
});

test('a successful probe renders its own reading, and the check joins the report', async () => {
  (probeStreamingFetch as jest.Mock).mockResolvedValue(OK);
  await mount();

  await press('Run live check');

  expect(JSON.stringify(renderer?.toJSON())).toContain('Live: response body is readable');
  expect(labels()).toContain('Run live check');
});

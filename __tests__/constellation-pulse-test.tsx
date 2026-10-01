/**
 * FLEET-2: the constellation pulse.
 *
 * The effect that starts `withRepeat(withTiming(1, { duration: 2600 }), -1, true)`
 * used to run unconditionally on mount, and `edgeOpacity` wraps EVERY host
 * edge — so a fleet with nothing running paid a UI-thread animation and a Skia
 * redraw at frame rate for the life of the screen, for a picture that never
 * changed. The native canvas is rendered here for real (Skia and Reanimated
 * mocked) so the assertions are about the animation calls and the shared value
 * itself, not about the text of the file.
 */
const mockReanimated = {
  cancelAnimation: jest.fn(),
  withRepeat: jest.fn((value: unknown) => value),
  withTiming: jest.fn((value: unknown, _config?: unknown) => value),
  /** Every shared value the canvas created, oldest first. */
  shared: [] as { value: unknown }[],
};

jest.mock('react-native-reanimated', () => {
  const easing = new Proxy(
    { bezier: () => (value: number) => value },
    {
      get: (target, key) =>
        key in target
          ? (target as unknown as Record<string | symbol, unknown>)[key]
          : () => (value: number) => value,
    },
  ) as Record<string, unknown>;
  return {
    Easing: easing,
    cancelAnimation: (value: unknown) => mockReanimated.cancelAnimation(value),
    useSharedValue: (value: unknown) => {
      const shared = { value };
      mockReanimated.shared.push(shared);
      return shared;
    },
    // The derived opacities read the shared value; the animation driving it is
    // what these tests judge.
    useDerivedValue: (compute: () => number) => compute(),
    withRepeat: (value: unknown) => mockReanimated.withRepeat(value),
    withTiming: (value: unknown, config?: unknown) => mockReanimated.withTiming(value, config),
  };
});

jest.mock('@shopify/react-native-skia', () => ({
  BlurMask: 'BlurMask',
  Canvas: 'Canvas',
  Circle: 'Circle',
  Group: 'Group',
  Line: 'Line',
  Path: 'Path',
  RadialGradient: 'RadialGradient',
  Skia: { Path: { Make: () => ({ moveTo: jest.fn(), quadTo: jest.fn() }) } },
  vec: (x: number, y: number) => ({ x, y }),
}));

jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#0af',
    accentMuted: '#00f2',
    accentWarm: '#fa0',
    accentWarmMuted: '#f80',
    statusConnectedMuted: '#0f0',
    textTertiary: '#777',
    statusDisconnected: '#f00',
  }),
}));

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  ConstellationCanvas,
  shouldPulse,
} from '@/components/fleet/constellation-canvas.native';
import { constellationModel, type ConstellationModel } from '@/lib/fleet/constellation-model';

/** A live gateway with a roster — the only shape that produces host edges. */
function quietFleet(): ConstellationModel {
  return constellationModel({
    profiles: [{ id: 'home', name: 'Home' }],
    connectedGatewayId: 'home',
    roster: [{ id: 'scout', displayName: 'Scout' }],
  });
}

function runningFleet(): ConstellationModel {
  return constellationModel({
    profiles: [{ id: 'home', name: 'Home' }],
    connectedGatewayId: 'home',
    roster: [{ id: 'scout', displayName: 'Scout' }],
    activityRuns: [{ id: 'run-1', botId: 'scout', status: 'running' }],
  });
}

describe('shouldPulse', () => {
  test('only a fleet with work in flight breathes', () => {
    expect(shouldPulse(quietFleet())).toBe(false);
    expect(shouldPulse(runningFleet())).toBe(true);
  });

  test('the count is the model summary, not a re-reading of badge tones', () => {
    // A `routine behind` badge is accent-toned too, but the map is not busy:
    // the HUD under it reads "1 Bot", and the animation has to agree with the
    // summary rather than with a badge tone.
    const behind = constellationModel({
      profiles: [{ id: 'home', name: 'Home' }],
      connectedGatewayId: 'home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
      routineReadStatus: 'ready',
      cronJobs: [{ id: 'r1', name: '[bot:scout] Morning', lastStatus: 'warn' }],
    });
    expect(behind.nodes.some((node) => node.badges.some((badge) => badge.tone === 'accent'))).toBe(true);
    expect(shouldPulse(behind)).toBe(false);
  });
});

describe('the native canvas only animates a fleet that is working', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    mockReanimated.cancelAnimation.mockClear();
    mockReanimated.withRepeat.mockClear();
    mockReanimated.withTiming.mockClear();
    mockReanimated.shared.length = 0;
  });

  afterEach(async () => {
    if (renderer) {
      const doomed = renderer;
      renderer = null;
      await act(async () => {
        doomed.unmount();
      });
    }
  });

  async function draw(graph: ConstellationModel) {
    await act(async () => {
      renderer = create(createElement(ConstellationCanvas, { model: graph, size: 320 }));
    });
  }

  function pulse(): unknown {
    // The last one the current render holds — the mock's `useSharedValue` is a
    // plain call, so each render mints a fresh object exactly as the effect
    // that drives it expects.
    return mockReanimated.shared[mockReanimated.shared.length - 1]?.value;
  }

  test('a quiet fleet starts no repeat animation at all', async () => {
    await draw(quietFleet());
    expect(mockReanimated.withTiming).not.toHaveBeenCalled();
    expect(mockReanimated.withRepeat).not.toHaveBeenCalled();
  });

  test('a quiet fleet is cancelled and holds one static opacity', async () => {
    await draw(quietFleet());
    // The cancellation is the point: an animation started by an earlier
    // working fleet has to stop, and the shared value has to land on a number
    // that never moves — `edgeOpacity` is `0.5 + 0.5 * pulse` over EVERY host
    // edge, so a still pulse is a still picture for a frame-rate price.
    expect(mockReanimated.cancelAnimation).toHaveBeenCalled();
    expect(pulse()).toBe(0.5);
  });

  test('a fleet with a run in flight starts the breath', async () => {
    await draw(runningFleet());
    expect(mockReanimated.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 2600 }));
    expect(mockReanimated.withRepeat).toHaveBeenCalledTimes(1);
    expect(pulse()).toBe(1);
  });

  test('the breath stops the moment the last run finishes', async () => {
    await draw(runningFleet());
    expect(mockReanimated.withRepeat).toHaveBeenCalledTimes(1);
    mockReanimated.cancelAnimation.mockClear();

    await act(async () => {
      renderer?.update(createElement(ConstellationCanvas, { model: quietFleet(), size: 320 }));
    });

    expect(mockReanimated.cancelAnimation).toHaveBeenCalled();
    expect(mockReanimated.withRepeat).toHaveBeenCalledTimes(1);
    expect(pulse()).toBe(0.5);
  });
});

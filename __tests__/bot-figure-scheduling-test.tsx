import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BotFigure } from '@/components/avatar/bot-figure';
import type { BotLook } from '@/lib/avatar/look';

const mockEnvironment = { reducedMotion: false };

jest.mock('react-native-reanimated', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  const identity = (value: number) => value;
  const withRepeat = jest.fn((animation: unknown) => ({ kind: 'repeat', animation }));
  const withTiming = jest.fn((to: unknown, config: unknown) => ({ kind: 'timing', to, config }));
  const withDelay = jest.fn((delay: number, animation: unknown) => ({ kind: 'delay', delay, animation }));
  const withSequence = jest.fn((...animations: unknown[]) => ({ kind: 'sequence', animations }));
  const easing = new Proxy({}, {
    get: (_target, key) => key === 'in' || key === 'out' || key === 'inOut' ? () => identity : identity,
  });
  return {
    __esModule: true,
    default: { View: 'Animated.View' },
    Easing: easing,
    cancelAnimation: jest.fn(),
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => mockEnvironment.reducedMotion,
    useSharedValue: (initial: number) => {
      const ref = react.useRef<{ current: unknown; get: () => unknown; set: (value: unknown) => void } | null>(null);
      if (!ref.current) {
        const shared: { current: unknown; get: () => unknown; set: (value: unknown) => void } = {
          current: initial,
          get: () => shared.current,
          set: (value: unknown) => { shared.current = value; },
        };
        ref.current = shared;
      }
      return ref.current;
    },
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
  };
});

jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: 'Svg',
  Defs: 'Defs',
  Ellipse: 'Ellipse',
  LinearGradient: 'LinearGradient',
  Path: 'Path',
  RadialGradient: 'RadialGradient',
  Stop: 'Stop',
}));
jest.mock('@/hooks/use-app-foreground', () => ({ useAppForeground: () => true }));

const {
  withDelay: mockWithDelay,
  withRepeat: mockWithRepeat,
  withSequence: mockWithSequence,
  withTiming: mockWithTiming,
} = jest.requireMock('react-native-reanimated') as {
  withDelay: jest.Mock;
  withRepeat: jest.Mock;
  withSequence: jest.Mock;
  withTiming: jest.Mock;
};

const LOOK = (face: BotLook['face']): BotLook => ({
  form: 'orb',
  face,
  tone: { from: '#7265E8', to: '#403986' },
  initial: 'A',
});

let renderer: ReactTestRenderer | null = null;

function mount(face: BotLook['face'], overrides: Partial<React.ComponentProps<typeof BotFigure>> = {}) {
  act(() => {
    renderer = create(React.createElement(BotFigure, {
      look: LOOK(face),
      size: 44,
      seed: 'aria',
      ...overrides,
    }));
  });
}

function unmount() {
  act(() => renderer?.unmount());
  renderer = null;
}

function clearAnimationCalls() {
  mockWithRepeat.mockClear();
  mockWithTiming.mockClear();
  mockWithDelay.mockClear();
  mockWithSequence.mockClear();
}

afterEach(() => {
  unmount();
  jest.clearAllTimers();
  jest.useRealTimers();
  mockEnvironment.reducedMotion = false;
  clearAnimationCalls();
});

test('idle waits off the UI thread and schedules one finite blink when its seeded timer expires', () => {
  jest.useFakeTimers();
  mount('bright');
  expect(mockWithRepeat).not.toHaveBeenCalled();
  expect(mockWithDelay).not.toHaveBeenCalled();
  expect(mockWithSequence).not.toHaveBeenCalled();
  expect(mockWithTiming).not.toHaveBeenCalled();

  jest.advanceTimersByTime(2599);
  expect(mockWithSequence).not.toHaveBeenCalled();
  expect(mockWithTiming).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1601);
  expect(mockWithSequence).toHaveBeenCalledTimes(1);
  expect(mockWithSequence.mock.calls[0]).toHaveLength(2);
  expect(mockWithTiming).toHaveBeenCalledWith(0.06, expect.objectContaining({ duration: 70, easing: expect.any(Function) }));
  expect(mockWithTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 140, easing: expect.any(Function) }));
});

test('idle blink timers cancel when the figure becomes inactive', () => {
  jest.useFakeTimers();
  mount('bright');
  expect(jest.getTimerCount()).toBe(1);

  act(() => {
    renderer?.update(React.createElement(BotFigure, {
      look: LOOK('bright'), size: 44, seed: 'aria', animationActive: false,
    }));
  });
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(10000);
  expect(mockWithSequence).not.toHaveBeenCalled();
});

test('a double blink is finite and keeps its short reset gap', () => {
  jest.useFakeTimers();
  mount('bright');

  jest.advanceTimersByTime(16000);
  expect(mockWithRepeat).not.toHaveBeenCalled();
  expect(mockWithDelay).toHaveBeenCalledWith(90, expect.anything());
});

test('wake opens after its short JS timer and leaves the seeded blink wait off the UI thread', () => {
  jest.useFakeTimers();
  mount('bright', { wake: true });
  expect(mockWithTiming).not.toHaveBeenCalledWith(1, expect.objectContaining({ duration: 280 }));

  jest.advanceTimersByTime(379);
  expect(mockWithTiming).not.toHaveBeenCalledWith(1, expect.objectContaining({ duration: 280 }));
  jest.advanceTimersByTime(1);
  expect(mockWithTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 280 }));
  expect(mockWithRepeat).not.toHaveBeenCalled();
  expect(mockWithDelay).not.toHaveBeenCalled();
});

test('reduced motion schedules no idle blink timer', () => {
  jest.useFakeTimers();
  mockEnvironment.reducedMotion = true;
  mount('bright');

  expect(jest.getTimerCount()).toBe(0);
  expect(mockWithRepeat).not.toHaveBeenCalled();
  expect(mockWithDelay).not.toHaveBeenCalled();
});

test('thinking starts only the tracks that face uses', () => {
  unmount();
  clearAnimationCalls();

  mount('bright', { mood: 'thinking' });
  expect(mockWithRepeat).toHaveBeenCalledTimes(3); // gaze x/y, thinking pulse
  unmount();
  clearAnimationCalls();

  mount('visor', { mood: 'thinking' });
  expect(mockWithRepeat).toHaveBeenCalledTimes(2); // scanner cycle, thinking pulse
});

test('an inactive figure schedules no loops, while touch reactions keep their short timing', () => {
  jest.useFakeTimers();
  mount('bright', { animationActive: false, reaction: 1 });
  expect(jest.getTimerCount()).toBe(0);
  expect(mockWithRepeat).not.toHaveBeenCalled();
  expect(mockWithTiming).not.toHaveBeenCalled();
  unmount();
  clearAnimationCalls();

  mount('bright', { reaction: 1 });
  expect(mockWithTiming.mock.calls.some(([, config]) => (config as { duration?: number }).duration === 160)).toBe(true);
  expect(mockWithDelay).toHaveBeenCalledWith(720, expect.anything());
});

test('the same Bot keeps its seeded first blink timer when mounted again', () => {
  jest.useFakeTimers();
  const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  mount('bright');
  const first = setTimeoutSpy.mock.calls.map(([, delay]) => delay).find((delay) => Number(delay) >= 2600 && Number(delay) <= 4200);
  expect(first).toBeGreaterThanOrEqual(2600);
  unmount();
  setTimeoutSpy.mockClear();
  clearAnimationCalls();

  mount('bright');
  const again = setTimeoutSpy.mock.calls.map(([, delay]) => delay).find((delay) => Number(delay) >= 2600 && Number(delay) <= 4200);
  expect(again).toBe(first);
  setTimeoutSpy.mockRestore();
});

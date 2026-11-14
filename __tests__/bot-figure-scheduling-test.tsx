import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BotFigure } from '@/components/avatar/bot-figure';
import type { BotLook } from '@/lib/avatar/look';

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
    useReducedMotion: () => false,
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
  clearAnimationCalls();
});

test('idle schedules only a seeded blink; thinking starts only the tracks that face uses', () => {
  mount('bright');
  expect(mockWithRepeat).toHaveBeenCalledTimes(1);
  unmount();
  clearAnimationCalls();

  mount('bright', { mood: 'thinking' });
  expect(mockWithRepeat).toHaveBeenCalledTimes(4); // blink, gaze x/y, thinking pulse
  unmount();
  clearAnimationCalls();

  mount('visor', { mood: 'thinking' });
  expect(mockWithRepeat).toHaveBeenCalledTimes(3); // blink, scanner cycle, thinking pulse
});

test('an inactive figure schedules no loops, while touch reactions keep their short timing', () => {
  mount('bright', { animationActive: false, reaction: 1 });
  expect(mockWithRepeat).not.toHaveBeenCalled();
  expect(mockWithTiming).not.toHaveBeenCalled();
  unmount();
  clearAnimationCalls();

  mount('bright', { reaction: 1 });
  expect(mockWithTiming.mock.calls.some(([, config]) => (config as { duration?: number }).duration === 160)).toBe(true);
  expect(mockWithDelay).toHaveBeenCalledWith(720, expect.anything());
});

test('the same Bot keeps its seeded blink intervals when mounted again', () => {
  mount('bright');
  const first = mockWithDelay.mock.calls.map(([delay]) => delay);
  unmount();
  clearAnimationCalls();

  mount('bright');
  expect(mockWithDelay.mock.calls.map(([delay]) => delay)).toEqual(first);
});

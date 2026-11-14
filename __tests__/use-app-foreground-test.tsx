import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useAppForeground } from '@/hooks/use-app-foreground';

let listeners: ((state: AppStateStatus) => void)[];
let removeListener: jest.Mock;
let renderer: ReactTestRenderer | null;

function ForegroundProbe({ observe }: { observe: (value: boolean) => void }) {
  observe(useAppForeground());
  return null;
}

function ForegroundPair({ observe }: { observe: (index: number, value: boolean) => void }) {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(ForegroundProbe, { observe: (value) => observe(0, value) }),
    React.createElement(ForegroundProbe, { observe: (value) => observe(1, value) }),
  );
}

beforeEach(() => {
  listeners = [];
  removeListener = jest.fn();
  renderer = null;
  AppState.currentState = 'background';
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    listener: (state: AppStateStatus) => void,
  ) => {
    listeners.push(listener);
    return { remove: removeListener };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  act(() => renderer?.unmount());
  jest.restoreAllMocks();
});

test('foreground state follows AppState and removes its listener on unmount', () => {
  const observed: [boolean[], boolean[]] = [[], []];
  act(() => {
    renderer = create(React.createElement(ForegroundPair, { observe: (index, value) => observed[index].push(value) }));
  });
  expect(observed.map((values) => values.at(-1))).toEqual([false, false]);
  expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  expect(AppState.addEventListener).toHaveBeenCalledTimes(1);

  act(() => listeners[0]('active'));
  expect(observed.map((values) => values.at(-1))).toEqual([true, true]);
  act(() => listeners[0]('background'));
  expect(observed.map((values) => values.at(-1))).toEqual([false, false]);

  act(() => renderer?.unmount());
  renderer = null;
  expect(removeListener).toHaveBeenCalledTimes(1);
});

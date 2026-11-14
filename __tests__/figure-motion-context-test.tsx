import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BotFigureAnimationProvider, useFigureAnimationActive } from '@/lib/avatar/figure-motion-context';

function Probe({ observe }: { observe: (active: boolean) => void }) {
  observe(useFigureAnimationActive());
  return null;
}

test('figure motion context defaults safe and follows the routed screen gate', () => {
  const observed: boolean[] = [];
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(Probe, { observe: (active) => observed.push(active) }));
  });
  expect(observed.at(-1)).toBe(true);

  act(() => {
    renderer.update(
      React.createElement(
        BotFigureAnimationProvider,
        { active: false, children: React.createElement(Probe, { observe: (active) => observed.push(active) }) },
      ),
    );
  });
  expect(observed.at(-1)).toBe(false);

  act(() => {
    renderer.update(
      React.createElement(
        BotFigureAnimationProvider,
        { active: true, children: React.createElement(Probe, { observe: (active) => observed.push(active) }) },
      ),
    );
  });
  expect(observed.at(-1)).toBe(true);
  act(() => renderer.unmount());
});

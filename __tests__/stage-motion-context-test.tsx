import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  StageMotionProvider,
  stageMotionActiveForDrawerStatus,
  useStageMotionActive,
} from '@/lib/stage/stage-motion-context';

declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function Probe({ report }: { report: (active: boolean) => void }) {
  report(useStageMotionActive());
  return null;
}

describe('stage motion context', () => {
  it('defaults active outside a drawer navigator', () => {
    const values: boolean[] = [];
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(createElement(Probe, { report: (active) => values.push(active) }));
    });
    expect(values).toEqual([true]);
    act(() => tree.unmount());
  });

  it('allows an enclosing stage to pause motion', () => {
    const values: boolean[] = [];
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <StageMotionProvider active={false}>
          <Probe report={(active) => values.push(active)} />
        </StageMotionProvider>,
      );
    });
    expect(values).toEqual([false]);
    act(() => tree.unmount());
  });

  it('keeps motion active only for the closed drawer state', () => {
    expect(stageMotionActiveForDrawerStatus('closed')).toBe(true);
    expect(stageMotionActiveForDrawerStatus('open')).toBe(false);
  });

  it('attaches the status hook only through the drawer navigator screen layout', () => {
    const layout = readSource('src', 'app', '(tabs)', '_layout.tsx');
    expect(layout).toContain('useDrawerStatus()');
    expect(layout).toContain('screenLayout={renderDrawerScreen}');
    expect(layout).toContain('stageMotionActiveForDrawerStatus(drawerStatus)');
  });
});

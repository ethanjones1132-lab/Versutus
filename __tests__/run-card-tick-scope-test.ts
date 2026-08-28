declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readRunCardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'activity', 'run-card.tsx'].join(SEP),
    'utf8',
  );
}

describe('run card tick scope', () => {
  test('the per-second clock lives in a dedicated LiveElapsed label, not the card body', () => {
    // useNow(1000, live) at run-card.tsx:40 re-rendered the whole card --
    // prompt, ticker and the expanded event log -- once a second while live.
    // The clock must now appear exactly once, inside LiveElapsed.
    const src = readRunCardSource();
    const uses = [...src.matchAll(/useNow\(/g)];
    expect(uses).toHaveLength(1);
    expect(src.slice(0, uses[0].index)).toMatch(/function LiveElapsed/);
  });

  test('the live header line renders LiveElapsed from the run start; finished lines are static', () => {
    const src = readRunCardSource();
    expect(src).toMatch(/<LiveElapsed startedAt=\{run\.startedAt\}\s*\/>/);
    // A finished run never ticks: its line is the fixed duration and the
    // relative time, both derived from finishedAt with no clock involved.
    expect(src).toMatch(/formatDuration\(\(run\.finishedAt \?\? run\.startedAt\) - run\.startedAt\)/);
    expect(src).toMatch(/formatRelativeTime\(run\.finishedAt \?\? run\.startedAt\)/);
  });

  test('RunCard is exported wrapped in memo so a tick or a sibling update skips the card body', () => {
    const src = readRunCardSource();
    expect(src).toMatch(/export const RunCard = memo\(function RunCard/);
    expect(src).not.toMatch(/export function RunCard/);
  });
});
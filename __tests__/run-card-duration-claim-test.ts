// The duration a settled run card claims.
//
// `RunCard`'s settled header line used to print
// `formatDuration((run.finishedAt ?? run.startedAt) - run.startedAt)`
// unconditionally, and a row restored from disk has no finish of its own:
// `normalizeRestoredRuns` stamps `finishedAt: run.finishedAt ?? Date.now()`
// when it reads the row (src/lib/gateway/session-persistence.ts:166), so a run
// the app was killed under showed how long the APP was closed as how long the
// RUN took. The row's own status says this device never learned the end of it
// (`runs.ts:25-30`).
//
// The card now prints a span only where the Bot scorecards' own fold would
// count one — `watchedRunSpanMs` (`src/lib/fleet/scorecard.ts`). That rule is
// the shipped one rather than a second copy of it on this surface: the same
// source pin as run-card-tick-scope-test.ts, reading the file instead of
// rendering it.

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

/** The settled branch of the header row — from the live-labels' sibling to the row's close. */
function settledHeaderBranch(src: string): string {
  const from = src.indexOf('<LiveElapsed startedAt');
  const to = src.indexOf('</View>', from);
  if (from < 0 || to < 0) throw new Error('settled header branch not found in run-card.tsx');
  return src.slice(from, to);
}

describe('run card duration claim', () => {
  test('the span comes from the shipped fold rule, not a second copy of it', () => {
    const src = readRunCardSource();

    expect(src).toMatch(/import \{ watchedRunSpanMs \} from '@\/lib\/fleet\/scorecard';/);
    expect(src).toMatch(/const span = watchedRunSpanMs\(run\);/);
    // The arithmetic that read a restored row's load-time stamp as a span is
    // gone from this surface: only the fold decides what this device watched end.
    expect(src).not.toMatch(/run\.finishedAt \?\? run\.startedAt\) - run\.startedAt/);
  });

  test('an unresolved row’s branch carries no duration at all', () => {
    const branch = settledHeaderBranch(readRunCardSource());

    // `formatDuration` is reached exactly once in the settled branch, and only
    // through the guard the predicate's answer arms — a row whose status says
    // this device never learned its end prints no span.
    expect([...branch.matchAll(/formatDuration\(/g)]).toHaveLength(1);
    expect(branch).toContain("{span === null ? '' : `${formatDuration(span)} · `}");
  });

  test('a settled row still says when it ended, through the same fallback as before', () => {
    const branch = settledHeaderBranch(readRunCardSource());

    expect(branch).toMatch(/formatRelativeTime\(run\.finishedAt \?\? run\.startedAt\)/);
    // The settled row's finish is read once — for when it ended — and never a
    // second time as a duration arithmetic beside it.
    expect([...branch.matchAll(/finishedAt/g)]).toHaveLength(1);
  });

  test('a live row still ticks from its own start, with no span claimed', () => {
    const src = readRunCardSource();

    expect(src).toMatch(/<LiveElapsed startedAt=\{run\.startedAt\}\s*\/>/);
    const uses = [...src.matchAll(/useNow\(/g)];
    expect(uses).toHaveLength(1);
    expect(src.slice(0, uses[0].index)).toMatch(/function LiveElapsed/);
    // The predicate is the one rule in the file, so it answers `null` for a
    // live row rather than the card deciding that separately.
    expect([...src.matchAll(/watchedRunSpanMs\(/g)]).toHaveLength(1);
  });
});

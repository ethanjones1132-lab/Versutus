declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('cron run sheet loading', () => {
  test('the pre-first-poll branch holds layout with two Skeleton rows', () => {
    // The first transcript poll is deferred a tick, and the sheet showed a
    // bare Loading caption in that window, then popped to full rows when
    // the read landed. The sheet now renders skeletons like the sibling
    // Cron section, so the layout holds instead of jumping.
    const src = readSource('src', 'components', 'activity', 'cron-run-sheet.tsx');
    expect(src).toContain('Skeleton');
    const loading = src.match(/!polledAt \? \([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\}/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\}/);
  });

  test('a successful empty poll still reports no turns', () => {
    // Once a poll has landed (polledAt set) with zero turns, the sheet must
    // say the run recorded nothing — the skeletons belong to the
    // pre-first-poll window only.
    const src = readSource('src', 'components', 'activity', 'cron-run-sheet.tsx');
    expect(src).toContain("{polledAt ? 'This run recorded no turns.' : 'Loading…'}");
  });

  test('a failed poll keeps the error line with the last good transcript', () => {
    // A poll failure is a gap in freshness, not evidence the run produced
    // nothing: the error renders while the turn list still maps below it.
    const src = readSource('src', 'components', 'activity', 'cron-run-sheet.tsx');
    expect(src).toMatch(/\{error \? \([\s\S]*?\) : null\}/);
    expect(src).toContain('turns.map((turn)');
  });

  test('the 3s poll cadence is untouched', () => {
    // The skeletons change only what the sheet shows while it waits; the
    // deferred first poll and the 3s interval still drive the reads.
    const src = readSource('src', 'components', 'activity', 'cron-run-sheet.tsx');
    expect(src).toContain('const POLL_MS = 3000;');
    expect(src).toContain('setTimeout(() => { void poll(); }, 0)');
    expect(src).toContain('setInterval(() => { void poll(); }, POLL_MS)');
  });
});

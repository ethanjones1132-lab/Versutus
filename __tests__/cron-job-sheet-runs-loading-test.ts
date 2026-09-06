declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  // Normalize line endings so the block regexes below do not depend on the
  // file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'cron-job-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('cron job sheet runs loading', () => {
  test('the pre-first-read branch holds layout with two Skeleton rows', () => {
    // The first run-history read is deferred a tick, and the sheet claimed
    // "No runs recorded yet." in that window, then popped to rows when the
    // read landed. The sheet now renders skeletons like the sibling Cron
    // surfaces, so the layout holds instead of flashing an empty claim.
    const src = readSheetSource();
    expect(src).toContain('Skeleton');
    const loading = src.match(/\{\!runsError && \!runsLoaded \? \([\s\S]*?\) : null\}/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\}/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\}/);
  });

  test('the no-runs line renders only after a successful empty read', () => {
    // Once a read has landed (runsLoaded set) with zero runs, the sheet
    // must say the routine recorded nothing — the skeletons belong to the
    // pre-first-read window only.
    const src = readSheetSource();
    const empty = src.match(
      /\{\!runsError && runsLoaded && runs\.length === 0 \? \([\s\S]*?\) : null\}/,
    )?.[0];
    expect(empty).toBeDefined();
    expect(empty).toContain('No runs recorded yet.');
  });

  test('the first read marks loaded on success and on refusal', () => {
    // A refused read must reach the runsError caption + Retry path, never
    // the skeletons: both loadRuns outcomes flip the flag.
    const src = readSheetSource();
    const loader = src.match(/const loadRuns = useCallback\(async \(\) => \{[\s\S]*?\}, \[cron, jobId\]\);/)?.[0];
    expect(loader).toBeDefined();
    expect(loader).toMatch(/setRunsLoaded\(true\)/);
    expect(loader?.match(/setRunsLoaded\(true\)/g)).toHaveLength(2);
  });

  test('the runsError caption and Retry path are untouched', () => {
    // The skeletons change only what the sheet shows while it waits; a
    // refused read still names the failure with a retry beside it.
    const src = readSheetSource();
    const blocks = src.match(/\{runsError \? \([\s\S]*?\) : null\}/g);
    expect(blocks).toBeDefined();
    expect(src).toMatch(/variant="caption" color="statusDisconnected"/);
    const retry = (blocks ?? []).find((block) => block.includes('label="Retry"'));
    expect(retry).toBeDefined();
    expect(retry).toMatch(/onPress=\{\(\) => void loadRuns\(\)\}/);
  });
});

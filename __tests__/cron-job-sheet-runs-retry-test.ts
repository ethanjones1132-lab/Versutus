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

describe('cron job sheet runs retry', () => {
  test('a refused run-history read offers a Retry action wired to loadRuns', () => {
    // A refused cron.runs read left the operator with the raw error caption
    // and sheet-remount as the only recourse. The sheet now renders a ghost
    // Retry button bound to the same re-read the mount effect runs.
    const src = readSheetSource();
    const blocks = src.match(/\{runsError \? \([\s\S]*?\) : null\}/g);
    expect(blocks).toBeDefined();
    const retry = (blocks ?? []).find((block) => block.includes('label="Retry"'));
    expect(retry).toBeDefined();
    expect(retry).toMatch(/variant="ghost"/);
    expect(retry).toMatch(/onPress=\{\(\) => void loadRuns\(\)\}/);
  });

  test('the runs Retry renders only on the failed-read path, never over a list', () => {
    // A successful read — empty or not — must show no Retry: the button is
    // the failed-read affordance, not a second refresh control.
    const src = readSheetSource();
    expect(src).toMatch(/\{runsError \? \(/);
    expect(src).not.toMatch(/runs\.length.*Retry/);
  });

  test('a successful empty read still guides with the no-runs line', () => {
    const src = readSheetSource();
    const empty = src.match(/\{\!runsError && runs\.length === 0 \? \([\s\S]*?\) : null\}/)?.[0];
    expect(empty).toBeDefined();
    expect(empty).toMatch(/No runs recorded yet\./);
  });

  test('the Run now / Pause controls and the controlError path are untouched', () => {
    const src = readSheetSource();
    expect(src).toMatch(/label=\{acting \? 'Working…' : 'Run now'\}/);
    expect(src).toMatch(/label=\{cronJobPauseLabel\(\{ paused \}\)\}/);
    expect(src).toMatch(/\{\s*controlError \? \(/);
  });

  test('run rows still open the transcript via onOpenRun', () => {
    const src = readSheetSource();
    expect(src).toMatch(/onPress=\{\(\) => onOpenRun\(run\.id\)\}/);
  });
});

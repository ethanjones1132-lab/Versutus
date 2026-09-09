declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readSection(): string {
  return readSource(['src', 'components', 'activity', 'cron-section.tsx']);
}

function readJobSheet(): string {
  return readSource(['src', 'components', 'activity', 'cron-job-sheet.tsx']);
}

function readOpenRun(): string {
  const src = readSection();
  const match = src.match(/onOpenRun=\{\(runId\) => \{[\s\S]*?\n        \}\}/);
  expect(match).not.toBeNull();
  return match![0];
}

// Opening a run used to setOpenJob(null) then setOpenRunId, and CronRunSheet
// onClose only cleared the run id — so after reading one transcript the
// operator landed on the cron list, not RUN HISTORY. Keep the job in state
// across the transcript and hide the job sheet only while the run is open.
describe('scheduled-job run history way back', () => {
  test('opening a run transcript does not dismiss the job', () => {
    const openRun = readOpenRun();
    expect(openRun).toContain('setOpenRunId(runId)');
    expect(openRun).not.toContain('setOpenJob(null)');
  });

  test('the job sheet is hidden only while a transcript is open, so closing the run restores RUN HISTORY', () => {
    const src = readSection();
    expect(src).toContain('job={openRunId ? null : openJob}');
    expect(src).toContain(
      "<CronRunSheet key={openRunId ?? 'no-run'} runId={openRunId} onClose={() => setOpenRunId(null)} />",
    );
  });

  test('the job sheet stays keyed on job id', () => {
    const src = readSection();
    expect(src).toContain("key={openJob?.id ?? 'no-job'}");
  });

  test('a run-row tap still opens CronRunSheet', () => {
    const sheet = readJobSheet();
    expect(sheet).toMatch(/onPress=\{\(\) => onOpenRun\(run\.id\)\}/);
    const src = readSection();
    expect(src).toContain('<CronRunSheet');
    expect(src).toContain('setOpenRunId(runId)');
  });

  test('dismissing the job or removing it still clears openJob', () => {
    const src = readSection();
    expect(src).toContain('onClose={() => setOpenJob(null)}');
    const removed = src.match(/onRemoved=\{\(\) => \{[\s\S]*?\n        \}\}/)?.[0];
    expect(removed).toBeDefined();
    expect(removed).toContain('setOpenJob(null)');
    expect(removed).toContain('void load()');
  });

  test('the CronRunSheet key and onClose stay byte-identical', () => {
    const src = readSection();
    expect(src).toContain(
      "<CronRunSheet key={openRunId ?? 'no-run'} runId={openRunId} onClose={() => setOpenRunId(null)} />",
    );
  });
});

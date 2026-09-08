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

const sheet = () =>
  readSource('src', 'components', 'activity', 'cron-job-sheet.tsx');
const section = () =>
  readSource('src', 'components', 'activity', 'cron-section.tsx');

// A confirmed Run-now starts the job on the host but the sheet kept
// rendering the run history it read at mount — the new run was missing
// until the sheet was closed and reopened. A confirmed Pause/Resume moved
// only the sheet-local override while the parent roster kept the old
// verdict until the next tab-focus reload.
describe('cron job sheet run/pause refresh', () => {
  test('a successful Run-now re-reads the sheet run history', () => {
    const src = sheet();
    const fn = src.match(
      /const submitRun = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/,
    )?.[0];
    expect(fn).toBeDefined();
    expect(fn).toContain('await botJobs.run(jobId)');
    // The history re-read lands inside the success path, before the
    // refusal branch — a refused run must not look like a fresh list.
    const runIdx = (fn ?? '').indexOf('await botJobs.run(jobId)');
    const reloadIdx = (fn ?? '').indexOf('await loadRuns()');
    const catchIdx = (fn ?? '').indexOf('catch');
    expect(reloadIdx).toBeGreaterThan(runIdx);
    expect(catchIdx).toBeGreaterThan(reloadIdx);
  });

  test('a successful Run-now and Pause/Resume notify the parent', () => {
    const src = sheet();
    // The callback is optional and mirrors onRemoved: a host without the
    // parent wiring keeps today's behaviour exactly.
    expect(src).toMatch(/onChanged\?: \(\) => void/);
    const runFn = src.match(
      /const submitRun = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/,
    )?.[0];
    expect(runFn).toMatch(/onChanged\?\.\(\)/);
    const pauseFn = src.match(
      /const submitTogglePause = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/,
    )?.[0];
    expect(pauseFn).toBeDefined();
    expect(pauseFn).toContain('setPausedOverride(!paused)');
    // The parent nudge fires only after the host confirmed the new state.
    const overrideIdx = (pauseFn ?? '').indexOf('setPausedOverride(!paused)');
    const notifyIdx = (pauseFn ?? '').indexOf('onChanged?.()');
    const catchIdx = (pauseFn ?? '').indexOf('catch');
    expect(notifyIdx).toBeGreaterThan(overrideIdx);
    expect(catchIdx).toBeGreaterThan(notifyIdx);
  });

  test('a refused Run-now or Pause/Resume keeps the last good state and names the error', () => {
    const src = sheet();
    // Both refusal paths stay byte-identical: name the failure, keep the
    // override the host last confirmed.
    expect(src.match(/setControlError\(describeCronJobControlError\(caught\)\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const pauseFn = src.match(
      /const submitTogglePause = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/,
    )?.[0];
    const overrideIdx = (pauseFn ?? '').indexOf('setPausedOverride(!paused)');
    const catchIdx = (pauseFn ?? '').indexOf('catch');
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(overrideIdx);
    // No notify on the refusal path: the parent roster must never adopt a
    // state the host did not take.
    const catchBlock = (pauseFn ?? '').match(/\} catch \(caught\) \{[\s\S]*?\} finally/)?.[0];
    expect(catchBlock).toBeDefined();
    expect(catchBlock).not.toContain('onChanged');
  });

  test('the parent re-reads the cron roster when the sheet reports a change', () => {
    const src = section();
    expect(src).toMatch(/onChanged=\{[^}]*void load\(\)/);
    // The sheet stays keyed by job id so each job still opens as a fresh
    // component with no stale run list.
    expect(src).toMatch(/key=\{openJob\?\.id/);
  });
});

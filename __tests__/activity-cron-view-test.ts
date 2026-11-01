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

const activity = () => readSource('src', 'app', '(tabs)', 'activity.tsx');
const runs = () => readSource('src', 'app', 'runs.tsx');
const layout = () => readSource('src', 'app', '_layout.tsx');
const jobSheet = () => readSource('src', 'components', 'activity', 'cron-job-sheet.tsx');
const cronModel = () => readSource('src', 'lib', 'gateway', 'cron.ts');

// Workflows slice 3b: the Activity tab is the scheduled-work view only. The
// individual run surface was extracted to its own /runs destination, reached
// from an explicit control on the tab. Nothing is deleted — the run history,
// its attribution and every run-history test moved with the surface (their
// assertions now read src/app/runs.tsx).
describe('Activity is the cron view, and runs live on their own destination', () => {
  test('the run surface is gone from the Activity tab', () => {
    const src = activity();
    expect(src).not.toContain('showRuns');
    expect(src).not.toContain('<ScorecardsSection');
    expect(src).not.toContain('activityRuns.length === 0');
    expect(src).not.toContain("label={starting ? 'Starting…' : 'Run task'}");
  });

  test('scheduled work is always on the tab', () => {
    expect(activity()).toContain('<CronSection cronReloadSignal={cronReloadSignal} />');
  });

  test('the tab links to the Runs destination', () => {
    expect(activity()).toContain("router.push('/runs')");
  });

  test('the must-still-work surface is untouched: approvals, targets and spend', () => {
    const src = activity();
    expect(src).toContain('ApprovalDecisionCard');
    expect(src).toContain('<AgentTargets');
    expect(src).toContain('<SpendEntryRow />');
  });

  test('the Runs destination carries the run surface', () => {
    const src = runs();
    expect(src).toContain("label={starting ? 'Starting…' : 'Run task'}");
    expect(src).toContain('<ScorecardsSection');
    expect(src).toContain('<RunCard run={item.run} highlighted={item.id === focusedRunId} onStop={stopActivityRun} />');
  });

  test('the Runs destination is a registered Stack route', () => {
    expect(layout()).toContain('name="runs"');
  });
});

// A run row is the only place Activity shows what one scheduled run did. The
// wire says `running` or "closed" and carries the host's `error` beside it, so
// the row must read that error (and any failure word in the status) as a
// failure — a closed run is not automatically a success.
describe('a scheduled run row names a failure, never a success', () => {
  test('the row renders the shared verdict from the cron model', () => {
    const src = jobSheet();
    // One rule, one place: the sheet asks the cron model rather than keeping a
    // private running/completed binary that the slash-command copy can drift
    // from.
    expect(src).toContain('cronRunSummary');
    expect(src).toContain("} from '@/lib/gateway/cron';");
    expect(src).toContain('subtitle={cronRunSummary(run)}');
    // The old local subtitle defaulted every non-running row to "completed".
    expect(src).not.toContain('function runSubtitle');
    expect(src).not.toMatch(/'running' : 'completed'/);
  });

  test('the cron model reads the error field and never defaults to completed', () => {
    const src = cronModel();
    expect(src).toContain('export function cronRunVerdict');
    expect(src).toContain('export function cronRunSummary');
    // The verdict is built from the error and the status word, not from a
    // two-way running/completed test that a failed run would slip through.
    expect(src).toMatch(/run\.error/);
    expect(src).not.toMatch(/status === 'running' \? 'running' : 'completed'/);
  });
});

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
    expect(src).toContain('<RunCard run={item.run} onStop={stopActivityRun} />');
  });

  test('the Runs destination is a registered Stack route', () => {
    expect(layout()).toContain('name="runs"');
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readActivity(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'app', '(tabs)', 'activity.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

// Workflows slice 3a: the Activity surface reads as scheduled work. Runs are
// hidden by default behind an explicit control; the cron section is always
// there. Nothing is deleted — the run history, its attribution and every
// run-history component and test stay in the tree.
describe('Activity hides the run surface behind an explicit control', () => {
  const src = readActivity();

  test('runs are hidden by default', () => {
    expect(src).toContain('const [showRuns, setShowRuns] = useState(false);');
  });

  test('the run rows only feed the list while the operator asked for them', () => {
    expect(src).toContain('data={showRuns ? listData : []}');
    expect(src).toContain('showRuns && runsSupported');
  });

  test('the post-run scorecards are gated with the runs they summarize', () => {
    expect(src).toMatch(/showRuns \? \(\s*<ScorecardsSection/);
  });

  test('scheduled work is always on the tab, never behind the run gate', () => {
    expect(src).toContain('<CronSection cronReloadSignal={cronReloadSignal} />');
  });

  test('one control flips it, and it names the state it will move to', () => {
    expect(src).toContain("label={showRuns ? 'Hide runs' : 'Show runs'}");
    expect(src).toContain('setShowRuns(');
  });

  test('the must-still-work surface is untouched: approvals, targets, spend and the empty copy', () => {
    expect(src).toContain('ApprovalDecisionCard');
    expect(src).toContain('<AgentTargets');
    expect(src).toContain('<SpendEntryRow />');
    expect(src).toContain('activityRuns.length === 0 && !pendingRunApproval');
    expect(src).toContain('<RunCard run={item.run} onStop={stopActivityRun} />');
  });
});

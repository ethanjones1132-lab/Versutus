// ─── Section heading hierarchy ──────────────────────────────────────────────
// One title-level heading per screen; every section header under it sits at
// headline, matching the ladder Settings already ships (title, then eyebrow +
// headline cards) and this sprint's Gate setup demotion. Pinned off the source
// so a restyle that re-promotes a card heading, or leaves Activity mixing
// body/title/headline at the same level, fails here, not on the phone.

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

const activityScreen = () => readSource('src', 'app', '(tabs)', 'activity.tsx');
const runsScreen = () => readSource('src', 'app', 'runs.tsx');
const capabilitiesScreen = () => readSource('src', 'app', 'gateway', 'capabilities.tsx');
const cronSection = () => readSource('src', 'components', 'activity', 'cron-section.tsx');
const scorecardsSection = () => readSource('src', 'components', 'activity', 'scorecards-section.tsx');
const approvalInbox = () => readSource('src', 'components', 'activity', 'approval-inbox.tsx');
const agentTargets = () => readSource('src', 'components', 'activity', 'agent-targets.tsx');
const toolsetsSection = () => readSource('src', 'components', 'gateway', 'toolsets-section.tsx');
const rpcMethodsSection = () => readSource('src', 'components', 'gateway', 'rpc-methods-section.tsx');
const healthChecksPane = () => readSource('src', 'components', 'gateway', 'health-checks-pane.tsx');
const pairedDevicesPane = () => readSource('src', 'components', 'gateway', 'paired-devices-pane.tsx');

function countTitles(src: string): number {
  return (src.match(/variant="title"/g) ?? []).length;
}

describe('named screens carry exactly one title-level heading in their own body', () => {
  test('Activity', () => {
    const src = activityScreen();
    expect(countTitles(src)).toBe(1);
    expect(src).toContain('<Text variant="title">Activity</Text>');
  });

  test('Runs', () => {
    const src = runsScreen();
    expect(countTitles(src)).toBe(1);
    expect(src).toContain('<Text variant="title">Runs</Text>');
  });

  test('Capabilities', () => {
    const src = capabilitiesScreen();
    expect(countTitles(src)).toBe(1);
    expect(src).toContain('<Text variant="title">Capabilities</Text>');
  });
});

describe('section headers sit at headline, never competing with the screen title', () => {
  test('CronSection heading is a headline, not a second title on Activity', () => {
    const src = cronSection();
    expect(src).toContain('<Text variant="headline">Cron ({jobs.length})</Text>');
    expect(countTitles(src)).toBe(0);
  });

  test('ScorecardsSection heading is a headline, not a second title on Runs', () => {
    const src = scorecardsSection();
    expect(src).toContain('<Text variant="headline">Scorecards</Text>');
    expect(countTitles(src)).toBe(0);
  });

  test('ToolsetsSection and RpcMethodsSection are headlines under Capabilities', () => {
    const toolsets = toolsetsSection();
    expect(toolsets).toContain('<Text variant="headline">Toolsets</Text>');
    expect(countTitles(toolsets)).toBe(0);
    const rpc = rpcMethodsSection();
    expect(rpc).toContain('<Text variant="headline">Answered RPC methods</Text>');
    expect(countTitles(rpc)).toBe(0);
  });

  test('Home pane headings are headlines under the hero gateway title', () => {
    const health = healthChecksPane();
    expect(health).toContain('<Text variant="headline">{healthChecksTitle(shown)}</Text>');
    expect(countTitles(health)).toBe(0);
    const paired = pairedDevicesPane();
    expect(paired).toContain('<Text variant="headline">{pairedDevicesToggleLabel(shown, false)}</Text>');
    expect(countTitles(paired)).toBe(0);
  });
});

describe('Activity section headers converge on one level', () => {
  test('the Approvals card heading is a headline, not body text', () => {
    const src = approvalInbox();
    expect(src).toContain('<Text variant="headline">Approvals</Text>');
    expect(src).not.toContain('<Text variant="body">Approvals</Text>');
    expect(countTitles(src)).toBe(0);
  });

  test('the Approval decisions card heading is a headline, not body text', () => {
    const src = activityScreen();
    expect(src).toContain('<Text variant="headline">Approval decisions</Text>');
    expect(src).not.toContain('<Text variant="body">Approval decisions</Text>');
  });

  test('Configured profiles stays a headline', () => {
    const src = agentTargets();
    expect(src).toContain('<Text variant="headline">Configured profiles</Text>');
    expect(countTitles(src)).toBe(0);
  });
});

describe('keep-working: copy, badges, and mounts under the demoted headings', () => {
  test('the Cron section keeps its running badge beside the heading', () => {
    expect(cronSection()).toContain('runningCount(jobs)');
    expect(cronSection()).toMatch(/<Badge label=\{`\$\{live\} running`\}/);
  });

  test('Scorecards keeps its window copy and weekly opt-in', () => {
    const src = scorecardsSection();
    expect(src).toContain('scorecardWindowCopy(runs.length)');
    expect(src).toContain('WEEKLY_REPORT_OPT_IN_LABEL');
  });

  test('the pane headings still derive their labels from the label helpers', () => {
    expect(healthChecksPane()).toContain('healthChecksTitle(shown)');
    expect(pairedDevicesPane()).toContain('pairedDevicesToggleLabel(shown, false)');
  });

  test('the screens still mount every section that lost its title rank', () => {
    const activity = activityScreen();
    expect(activity).toContain('<ApprovalInbox />');
    expect(activity).toContain('<CronSection');
    expect(activity).toContain('<AgentTargets');
    const runs = runsScreen();
    expect(runs).toContain('<ScorecardsSection');
    const capabilities = capabilitiesScreen();
    expect(capabilities).toContain('<CapabilitiesSection />');
    expect(capabilities).toContain('<ToolsetsSection />');
    expect(capabilities).toContain('<RpcMethodsSection />');
  });
});

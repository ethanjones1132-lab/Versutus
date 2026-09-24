declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const activity = () => readSource('src', 'app', '(tabs)', 'activity.tsx');
const runCard = () => readSource('src', 'components', 'activity', 'run-card.tsx');
const cronSection = () => readSource('src', 'components', 'activity', 'cron-section.tsx');
const cronJobSheet = () => readSource('src', 'components', 'activity', 'cron-job-sheet.tsx');
const approvalCard = () => readSource('src', 'components', 'activity', 'approval-decision-card.tsx');
const scorecards = () => readSource('src', 'components', 'activity', 'scorecards-section.tsx');
const agentTargets = () => readSource('src', 'components', 'activity', 'agent-targets.tsx');
const spendEntry = () => readSource('src', 'components', 'gateway', 'spend-entry-row.tsx');

describe('Activity carries quieter violet weight than Chat', () => {
  test('resting Activity surfaces avoid focus, glass, and gold roles', () => {
    for (const read of [activity, runCard, cronSection, cronJobSheet, approvalCard, scorecards, agentTargets, spendEntry]) {
      const src = read();
      expect(src).not.toMatch(/accentWarm|accentWarmMuted|glassBorder|glassHighlight|Palette\.gold|rgba\(229, 198, 126/);
    }
  });

  test('run and approval cards use the muted brand pair for their visual state', () => {
    const run = runCard();
    expect(run).toContain('? tokens.accent');
    expect(run).toContain('? tokens.accentMuted');

    const approval = approvalCard();
    expect(approval).toContain('tokens.statusDisconnected : tokens.accent');
    expect(approval).toContain('color="accent"');
    expect(approval).not.toContain('color="accentWarm"');
  });

  test('health and failure copy uses semantic status colors', () => {
    const cron = cronSection();
    expect(cron).toContain("warn: 'statusConnecting'");
    expect(cron).toContain('color="statusDisconnected"');

    const scorecardsSource = scorecards();
    expect(scorecardsSource).toContain('color="statusDisconnected"');
  });

  test('secondary Activity cards sit on inset panels while their surfaces stay flat', () => {
    const screen = activity();
    expect(screen).toContain('<Card variant="inset" padding={Spacing.three} style={styles.runsEntryCard}>');
    expect(screen).toContain('<Card variant="inset" padding={Spacing.three} style={styles.card}>');
    expect(screen).not.toMatch(/tokens\.glass|tokens\.glassBorder|Palette\.gold/);
  });

  test("Activity's supporting entry points keep their existing routes and callbacks", () => {
    const screen = activity();
    expect(screen).toContain("router.push('/runs')");
    expect(screen).toContain('<ApprovalInbox />');
    expect(screen).toContain('<CronSection cronReloadSignal={cronReloadSignal} />');
    expect(screen).toContain('<SpendEntryRow />');
    expect(screen).toContain('<AgentTargets');

    const cron = cronSection();
    expect(cron).toContain('botJobs.create(gatewayJobInput(submitted))');
    expect(cron).toContain('onPress={() => setOpenJob(job)}');
  });
});

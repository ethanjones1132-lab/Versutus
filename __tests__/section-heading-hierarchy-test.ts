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
const todaySection = () => readSource('src', 'components', 'activity', 'today-section.tsx');
const routinesSection = () => readSource('src', 'components', 'activity', 'routines-section.tsx');
const toolsetsSection = () => readSource('src', 'components', 'gateway', 'toolsets-section.tsx');
const rpcMethodsSection = () => readSource('src', 'components', 'gateway', 'rpc-methods-section.tsx');
const healthChecksPane = () => readSource('src', 'components', 'gateway', 'health-checks-pane.tsx');
const pairedDevicesPane = () => readSource('src', 'components', 'gateway', 'paired-devices-pane.tsx');
const setupIdentity = () =>
  readSource('src', 'components', 'gateway', 'gateway-identity-section.tsx');
const providerForm = () =>
  readSource('src', 'components', 'gateway', 'provider-registration-form.tsx');
const environmentForm = () =>
  readSource('src', 'components', 'gateway', 'environment-registration-form.tsx');

function countTitles(src: string): number {
  return (src.match(/variant="title"/g) ?? []).length;
}

describe('named screens carry exactly one title-level heading in their own body', () => {
  test('Activity', () => {
    // Activity opens on the shared header (AppHeader page), the one heading
    // above its sections; no card inside it is promoted to a title.
    const src = activityScreen();
    expect(countTitles(src)).toBe(0);
    expect((src.match(/<AppHeader/g) ?? []).length).toBe(1);
    expect(src).toContain('title="Activity"');
  });

  test('Runs', () => {
    // Runs opens as Activity does: the shared page header, and nothing inside
    // it promoted to a second title.
    const src = runsScreen();
    expect(countTitles(src)).toBe(0);
    expect((src.match(/<AppHeader/g) ?? []).length).toBe(1);
    expect(src).toContain('title="Runs"');
  });

  test('Capabilities', () => {
    const src = capabilitiesScreen();
    expect(countTitles(src)).toBe(0);
    expect((src.match(/<AppHeader/g) ?? []).length).toBe(1);
    expect(src).toContain('title="Capabilities"');
  });
});

describe('section headers sit at headline, never competing with the screen title', () => {
  test('CronSection keeps its component heading at headline level', () => {
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

describe('Activity sections use one headline level beneath the page title', () => {
  test('Today and Routines have their own headers, without the removed Activity sections', () => {
    const screen = activityScreen();
    const today = todaySection();
    const routines = routinesSection();
    expect(screen).toContain("options={[{ key: 'today', label: 'Today' }, { key: 'routines', label: 'Routines' }]}");
    expect(today).toContain('<SectionHeader title="Needs you" />');
    expect(today).toContain('<SectionHeader title="In progress" />');
    expect(routines).toMatch(/<SectionHeader title=\{`Routines/);
    expect(countTitles(today)).toBe(0);
    expect(countTitles(routines)).toBe(0);
    expect(screen).not.toContain('<CronSection');
    expect(screen).not.toContain('<AgentTargets');
    expect(screen).not.toContain('<SpendEntryRow');
  });
});

describe('Gate setup child card headings sit at headline under the one screen title', () => {
  test('Gateway identity is a headline, not a second title on Gate setup', () => {
    const src = setupIdentity();
    expect(src).toContain('<Text variant="headline">Gateway identity</Text>');
    expect(countTitles(src)).toBe(0);
  });

  test('Add a provider is a headline, not a second title on Gate setup', () => {
    const src = providerForm();
    expect(src).toContain('<Text variant="headline">Add a provider</Text>');
    expect(countTitles(src)).toBe(0);
  });

  test('Add/Edit CLI environment headings are headlines, not second titles on Gate setup', () => {
    const src = environmentForm();
    expect(src).toContain(
      '<Text variant="headline">{editing ? \'Edit CLI environment\' : \'Add a CLI environment\'}</Text>',
    );
    expect(countTitles(src)).toBe(0);
  });

  test('setup keeps one screen title and still mounts its three child cards', () => {
    const setup = readSource('src', 'app', 'gateway', 'setup.tsx');
    expect(countTitles(setup)).toBe(0);
    expect((setup.match(/<AppHeader/g) ?? []).length).toBe(1);
    expect(setup).toContain('title="Gate setup"');
    expect(setup).toContain('<GatewayIdentitySection />');
    expect(setup).toContain('<ProvidersSection />');
    expect(setup).toContain('<EnvironmentsSection />');
  });

  test('the demoted headings keep their copy and form fields stay wired', () => {
    expect(setupIdentity()).toContain('Gateway identity');
    expect(providerForm()).toContain('Add a provider');
    expect(environmentForm()).toContain('Edit CLI environment');
    expect(environmentForm()).toContain('Add a CLI environment');
    expect(providerForm()).toContain('onSubmit({ id, label, profile, baseUrl })');
    expect(environmentForm()).toContain('bindingsProblem');
    expect(setupIdentity()).toContain('gatewayIdentityRows(activeManifest)');
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

  test('the screens mount their current sections after the composition change', () => {
    const activity = activityScreen();
    const today = todaySection();
    expect(today).toContain('<ApprovalInbox />');
    expect(activity).toContain('<TodaySection');
    expect(activity).toContain('<RoutinesSection');
    expect(activity).not.toContain('<CronSection');
    expect(activity).not.toContain('<AgentTargets');
    const runs = runsScreen();
    expect(runs).toContain('<ScorecardsSection');
    const capabilities = capabilitiesScreen();
    expect(capabilities).toContain('<CapabilitiesSection />');
    expect(capabilities).toContain('<ToolsetsSection />');
    expect(capabilities).toContain('<RpcMethodsSection />');
  });
});

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

function readActivity(): string {
  return readSource(['src', 'app', '(tabs)', 'activity.tsx']);
}

function readRuns(): string {
  return readSource(['src', 'app', 'runs.tsx']);
}

function readDashboard(): string {
  return readSource(['src', 'components', 'gateway', 'gateway-home-dashboard.tsx']);
}

function readFleet(): string {
  return readSource(['src', 'app', 'fleet.tsx']);
}

// Fleet owns saved gateway selection; Activity is the Today/Routines surface.
describe('gateway selection stays on Fleet and Activity stays focused', () => {
  test('Activity shows Today and Routines without a profile switcher', () => {
    const activity = readActivity();
    expect(activity).toContain('<TodaySection');
    expect(activity).toContain('<RoutinesSection');
    expect(activity).not.toContain('<AgentTargets');
    expect(activity).not.toContain('connectGateway(');
  });

  test('Fleet connects the selected gateway and catches connection refusal', () => {
    const fleet = readFleet();
    expect(fleet).toContain('void connectGateway(gateway).catch((error: unknown) => setConnectFailure(error))');
    expect(fleet).toContain('<ConstellationView');
    expect(fleet).toContain('onPressNode={handlePressNode}');
  });

  test('Start-a-run lives on the Runs destination Activity links to', () => {
    const src = readRuns();
    expect(src).toContain('Start a run');
    expect(src).toContain("label={starting ? 'Starting…' : 'Run task'}");
    expect(src).toContain('onPress={() => void startRun()}');
  });

  test('the Home dashboard Chat hops stay on that tab, not on a gateway tap', () => {
    const dashboard = readDashboard();
    expect(dashboard).toContain("onOpenChat={() => router.push('/chat')}");
    expect(dashboard).toContain("router.push('/chat')");
    expect(readActivity()).toContain("router.push('/chat')");
    expect(readActivity()).toContain('selectSession(sessionId, { backendId, botId })');
  });
});

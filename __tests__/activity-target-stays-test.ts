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

function readTargets(): string {
  return readSource(['src', 'components', 'activity', 'agent-targets.tsx']);
}

function readDashboard(): string {
  return readSource(['src', 'components', 'gateway', 'gateway-home-dashboard.tsx']);
}

function readSelect(): string {
  const src = readActivity();
  const match = src.match(/onSelect=\{\(gateway\) => \{[\s\S]*?\n        \}\}/);
  expect(match).not.toBeNull();
  return match![0];
}

// AgentTargets on Activity is the gateway-profile switcher. Connecting used
// to hop to Chat, which left Start-a-run (the reason to switch on this tab)
// off-screen until the operator navigated back. Stay on Activity after the
// tap so a run on the newly selected gateway can be started in place.
describe('activity gateway target stays on Activity', () => {
  test('tapping a gateway profile connects it without leaving Activity', () => {
    const select = readSelect();
    expect(select).toContain('void connectGateway(gateway)');
    expect(select).not.toContain("router.push('/chat')");
    expect(readActivity()).not.toContain("router.push('/chat')");
  });

  test('the tap still calls connectGateway with the tapped gateway profile', () => {
    const select = readSelect();
    expect(select).toContain('connectGateway(gateway)');
    const targets = readTargets();
    expect(targets).toContain('onPress={() => onSelect(gateway)}');
  });

  test('AgentTargets remains the Activity switcher', () => {
    const src = readActivity();
    expect(src).toContain('<AgentTargets');
    expect(src).toContain('gateways={gateways}');
    expect(src).toContain('activeGatewayId={activeGateway?.id}');
    expect(src).toContain('status={status}');
  });

  test('Start-a-run still lives on the same Activity screen', () => {
    const src = readActivity();
    expect(src).toContain('Start a run');
    expect(src).toContain("label={starting ? 'Starting…' : 'Run task'}");
    expect(src).toContain('onPress={() => void startRun()}');
  });

  test('the Home dashboard Chat hops stay on that tab, not this one', () => {
    const dashboard = readDashboard();
    expect(dashboard).toContain("onOpenChat={() => router.push('/chat')}");
    expect(dashboard).toContain("router.push('/chat')");
    expect(readActivity()).not.toContain("router.push('/chat')");
  });
});

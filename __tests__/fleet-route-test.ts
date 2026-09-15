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

const fleetRoute = () => readSource('src', 'app', 'fleet.tsx');
const rootLayout = () => readSource('src', 'app', '_layout.tsx');
const homeDashboard = () =>
  readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');

// D2's route is a lens over state the app already holds: one existing roster
// read, the reachability wave the dashboard already mounts, and no fetch or
// poll of its own. The taps drive the shipped destinations.
describe('the fleet route projects the fleet and adds no protocol', () => {
  test('it folds provider state plus the existing roster read into the pure model', () => {
    const src = fleetRoute();
    expect(src).toContain('useGateway()');
    expect(src).toContain('useGatewayReachability(');
    expect(src).toContain('listBots(');
    expect(src).toContain('fleetConstellationInput(');
    expect(src).toContain('constellationModel(');
    expect(src).toContain('activityRuns');
    expect(src).toContain('pendingRunApproval');
    expect(src).toContain('activeGateway');
  });

  test('it renders the shared view and never a fetch of its own', () => {
    const src = fleetRoute();
    expect(src).toContain('<ConstellationView');
    expect(src).not.toContain('gatewayRequest(');
  });

  test('a Bot tap opens the Bot Chat, a gateway tap connects, a badge opens Activity', () => {
    const src = fleetRoute();
    expect(src).toContain('onPressNode={handlePressNode}');
    expect(src).toContain('onPressApproval={handlePressApproval}');
    expect(src).toContain('openBot(');
    expect(src).toContain("requestSurface({ kind: 'bot'");
    expect(src).toContain('connectGateway(');
    expect(src).toContain("router.push('/activity')");
  });

  test('the model hands the Bot id to the tap rather than the route parsing it', () => {
    const src = fleetRoute();
    expect(src).toContain('node.botId');
    expect(src).not.toContain("node.id.replace(");
    expect(src).not.toContain("split(':')");
  });

  test('a gateway tap is gated by the pure handshake decision, and its lines are painted', () => {
    const src = fleetRoute();
    expect(src).toContain('gatewayHandshake(');
    expect(src).toContain('!handshake.canConnect');
    expect(src).toContain('handshakeStatus');
  });
});

describe('the fleet is a Stack destination with one entry on Home', () => {
  test('the Stack registers a full-screen (not modal) fleet route', () => {
    const src = rootLayout();
    expect(src).toContain('<Stack.Screen');
    expect(src).toContain('name="fleet"');
    const fleet = src.slice(src.indexOf('name="fleet"'));
    expect(fleet.slice(0, fleet.indexOf('/>'))).not.toContain("presentation: 'modal'");
  });

  test("Home's connection hero carries the entry button", () => {
    const src = homeDashboard();
    expect(src).toContain("router.push('/fleet')");
  });
});

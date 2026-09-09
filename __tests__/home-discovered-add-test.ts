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

function readDashboard(): string {
  return readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');
}

function readDiscoveredCollapsible(): string {
  const src = readDashboard();
  const start = src.indexOf('<GlassCollapsible title="Found on your network">');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('</GlassCollapsible>', start);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + '</GlassCollapsible>'.length);
}

function readHandleAddDiscovered(): string {
  const src = readDashboard();
  const start = src.indexOf('const handleAddDiscovered = useCallback(');
  expect(start).toBeGreaterThan(-1);
  const empty = src.indexOf('if (gateways.length === 0)');
  expect(empty).toBeGreaterThan(start);
  return src.slice(start, empty);
}

// Home's empty "Found on your network" collapsible named nearby gateways
// with a count and no Add, while Gate setup Manage already renders
// DiscoveredGatewayRow + handleAddDiscovered (addGateway, connectGateway,
// then open Chat). Offer that same Add on the empty Home so a discovered
// gateway can be saved without leaving for Settings → Gate setup → Manage.
describe('Home empty discovered gateways offer Add', () => {
  test('the Found-on-your-network collapsible maps discovery.gateways to DiscoveredGatewayRow', () => {
    const src = readDashboard();
    expect(src).toContain("from '@/components/discovered-gateway-row'");
    const block = readDiscoveredCollapsible();
    expect(block).toMatch(/discovery\.gateways\.map\(\(gateway\) => \(/);
    expect(block).toMatch(/<DiscoveredGatewayRow\b/);
    expect(block).toMatch(/key=\{gateway\.id\}/);
    expect(block).toMatch(/gateway=\{gateway\}/);
    expect(block).toMatch(/isScanning=\{discovery\.status === 'scanning'\}/);
    expect(block).toMatch(/onAdd=\{handleAddDiscovered\}/);
    expect(block).not.toMatch(/onAdd=\{\(\) => void handleAddDiscovered\(/);
  });

  test('Add uses the same addGateway + connectGateway + open-chat path as Gate setup', () => {
    const src = readDashboard();
    expect(src).toMatch(/connectGateway,\s*addGateway,/);
    const handler = readHandleAddDiscovered();
    expect(handler).toContain('const beacon = discovery.gateways.find((item) => item.id === beaconId);');
    expect(handler).toContain('const profile = await addGateway({');
    expect(handler).toContain('name: beacon.name,');
    expect(handler).toContain('url: beacon.url,');
    expect(handler).toContain('tlsFingerprint: beacon.tlsFingerprint,');
    expect(handler).toContain("discoverySource: beacon.source === 'local' ? 'local' : 'tailscale',");
    expect(handler).toContain('await connectGateway(profile);');
    expect(handler).toContain("router.push('/chat')");
  });

  test('HomeStatusCard still wires retryAutoConnect', () => {
    const src = readDashboard();
    expect(src).toContain('<HomeStatusCard');
    expect(src).toContain('onConnect={() => void retryAutoConnect()}');
  });

  test('describeHomeEmptyState visibility rules stay byte-identical', () => {
    const src = readSource('src', 'lib', 'home', 'home-empty-state.ts');
    expect(src).toContain("showPairing: status === 'pairing' && !!deviceId,");
    expect(src).toContain("showTroubleshooting: !!lastError && connectionPhase === 'failed',");
    expect(src).toContain('showDiscovered: discoveredCount > 0,');
    expect(src).toContain('showSetupAction: !tailscaleHost || isGatewayTokenRequiredMessage(lastError),');
    expect(src).toContain("setupLabel: tailscaleHost ? 'Update setup token' : 'Set up PC address',");
  });

  test('the onboarding setup action stays byte-identical', () => {
    const src = readDashboard();
    expect(src).toContain('{model.showSetupAction ? (');
    expect(src).toContain('<Link href="/onboarding" asChild>');
    expect(src).toContain('<Button label={model.setupLabel} variant="secondary" />');
  });

  test("Gate setup's discovered rows and handleAddDiscovered stay byte-identical", () => {
    const section = readSource('src', 'components', 'gateway', 'gateway-management-section.tsx');
    expect(section).toMatch(/discovery\.gateways\.map\(\(gateway\) => \(/);
    expect(section).toMatch(/<DiscoveredGatewayRow\b/);
    expect(section).toMatch(/key=\{gateway\.id\}/);
    expect(section).toMatch(/isScanning=\{discovery\.status === 'scanning'\}/);
    expect(section).toMatch(/onAdd=\{handleAddDiscovered\}/);
    const hook = readSource('src', 'hooks', 'use-gateway-settings-screen.ts');
    expect(hook).toContain('const handleAddDiscovered = useCallback(');
    expect(hook).toContain('const beacon = discovery.gateways.find((item) => item.id === beaconId);');
    expect(hook).toContain('const profile = await addGateway({');
    expect(hook).toContain('await connectGateway(profile);');
    expect(hook).toContain("router.push('/chat')");
  });

  test('the nearby caption still names auto-connect', () => {
    const block = readDiscoveredCollapsible();
    expect(block).toContain(
      'will use them automatically when connecting.',
    );
  });
});

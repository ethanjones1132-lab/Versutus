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

function home(): string {
  return readSource('src', 'app', '(tabs)', 'home.tsx');
}

function dashboard(): string {
  return readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');
}

// CHARTER priority 3 / docs/visual-direction-2026-09.md: Home is demoted to a
// thin status residual — not a co-equal command-center dashboard. The header
// names the live connection instead of branding "Command center"; the old
// StatTile metric grid collapses onto one hairline strip; the power-user
// panes (health, devices, capability hive/list) stack behind a single
// overflow so the default read is status + entry points.
describe('Home is a residual status strip, not a command center', () => {
  test('the header no longer brands Command center', () => {
    expect(home()).not.toContain('Command center');
    expect(home()).toContain("subtitle={");
    expect(home()).toContain("'Connect your gateway'");
  });

  test('the header subtitle carries the live connection status', () => {
    const src = home();
    expect(src).toContain("'Connected'");
    expect(src).toContain("'Needs approval'");
    expect(src).toContain("'Disconnected'");
    expect(src).toMatch(/gateways\.length === 0\s*\?\s*'Connect your gateway'/);
  });

  test('the StatTile grid is gone — counts live on one flat status strip', () => {
    const src = dashboard();
    expect(src).not.toContain('StatTile');
    expect(src).not.toContain('statsGrid');
    expect(src).toContain('statusStrip');
    // The strip still reports every count the grid used to own, so the
    // memoized derivations keep a consumer (no dead-use lint, no lost glance).
    expect(src).toMatch(/style=\{styles\.statusStrip\}/);
    const strip = src.match(/<View style=\{styles\.statusStrip\}>[\s\S]*?<\/View>/)?.[0];
    expect(strip).toBeDefined();
    expect(strip).toContain('gateways.length');
    expect(strip).toContain('activityRuns.length');
    expect(strip).toContain('activeRuns.length');
    expect(strip).toContain('capabilityCount');
    // Flat panel + cool hairline, per the locked material language.
    expect(src).toMatch(/statusStrip:[\s\S]*?backgroundColor: Palette\.backgroundElevated/);
    expect(src).toMatch(/statusStrip:[\s\S]*?borderColor: Palette\.border/);
  });

  test('the power-user panes stack behind one Diagnostics overflow', () => {
    const src = dashboard();
    const start = src.indexOf('<GlassCollapsible title="Diagnostics">');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('</GlassCollapsible>', start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    for (const needle of [
      '<HealthChecksPane',
      '<PairedDevicesPane',
      '<CapabilityHive',
      '<GatewayCapabilities',
      'Refresh capabilities',
    ]) {
      expect(block).toContain(needle);
    }
    // They no longer render as loose top-level cards on the residual screen.
    const outside = src.slice(0, start) + src.slice(end + '</GlassCollapsible>'.length);
    expect(outside).not.toContain('<HealthChecksPane');
    expect(outside).not.toContain('<PairedDevicesPane');
    expect(outside).not.toContain('<CapabilityHive');
    expect(outside).not.toContain('<GatewayCapabilities');
  });

  test('connect-gateway and settings entries stay within reach of the residual', () => {
    expect(home()).toContain("router.push('/gateway/settings')");
    const src = dashboard();
    // Empty-state connect CTA (one tap from Chat root via Home).
    expect(src).toContain('onConnect={() => void retryAutoConnect()}');
    expect(src).toContain("onOpenChat={() => router.push('/chat')}");
    // Saved-gateway retry stays on the status card.
    expect(src).toContain('label="Retry connection"');
  });
});

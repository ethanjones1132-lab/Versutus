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

function dashboard(): string {
  return readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');
}

function healthPane(): string {
  return readSource('src', 'components', 'gateway', 'health-checks-pane.tsx');
}

function devicesPane(): string {
  return readSource('src', 'components', 'gateway', 'paired-devices-pane.tsx');
}

// Home's failures used to name their cause in the dimmest styles available:
// the no-gateway refusal sat as a tertiary caption nested inside the
// Troubleshooting collapsible, and both dashboard panes destroyed the thrown
// message at the catch — surfacing only a fixed micro line plus a ghost
// Retry. Each failure now travels through the repo's ErrorCard with the
// kept cause, per peers toolsets-section and the tab refresh notices.
describe('the no-gateway refusal reads as an ErrorCard above the checklist', () => {
  test('the ErrorCard renders above the Troubleshooting collapsible in the empty branch', () => {
    const src = dashboard();
    const emptyAt = src.indexOf('if (gateways.length === 0)');
    expect(emptyAt).toBeGreaterThan(-1);
    const cardAt = src.indexOf('<ErrorCard', emptyAt);
    const troubAt = src.indexOf('<GlassCollapsible title="Troubleshooting">');
    expect(cardAt).toBeGreaterThan(emptyAt);
    expect(troubAt).toBeGreaterThan(cardAt);
    expect(src).toMatch(/\{model\.showTroubleshooting \? \(\s*<ErrorCard/);
  });

  test('the card keeps the humanized cause and adds no second retry for the same failure', () => {
    // HomeStatusCard already offers "Try again" (→ retryAutoConnect) for a
    // failed phase — one retry control per failure (iter-328). The card
    // carries cause/affected/next; it does not duplicate the control.
    const src = dashboard();
    const cardAt = src.indexOf('<ErrorCard', src.indexOf('if (gateways.length === 0)'));
    const block = src.slice(cardAt, src.indexOf(') : null}', cardAt));
    expect(block).toContain('{...humanizeGatewayError(lastError)}');
    expect(block).not.toContain('onRetry');
    expect(block).not.toContain('describeGatewayError');
  });

  test('the checklist keeps its copy and loses the nested tertiary error line', () => {
    const src = dashboard();
    const start = src.indexOf('<GlassCollapsible title="Troubleshooting">');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('</GlassCollapsible>', start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain('Hermes (or Gate) listening on the PC');
    expect(block).not.toContain('describeGatewayError');
    expect(block).not.toContain('color="tertiary"');
    expect(src).not.toContain('describeGatewayError');
  });
});

describe('the health-checks pane keeps the thrown message and answers with an ErrorCard', () => {
  test('the catch stores the caught message and a parsed read clears it', () => {
    const src = healthPane();
    expect(src).toMatch(
      /catch \(caught\) \{\s*fold\(\{ ok: false \}\);\s*setError\(caught instanceof Error \? caught\.message : String\(caught\)\);\s*\}/,
    );
    expect(src).toMatch(
      /const read = diagnosticsReadFromUnknown\(payload\);\s*fold\(read\);\s*if \(read\.ok\) setError\(null\);/,
    );
    expect(src).toMatch(/useState<string \| null>\(null\)/);
  });

  test('a failed read renders the ErrorCard with the kept cause and a Retry wired to load', () => {
    const src = healthPane();
    expect(src).toMatch(/\{shown\.failed \? \(\s*<ErrorCard/);
    expect(src).toMatch(/cause=\{error \?\? copy \?\? 'Health checks could not be read\.'\}/);
    expect(src).toMatch(/onRetry=\{\(\) => void load\(\)\}/);
    expect(src).not.toMatch(/label="Retry"/);
    // The failure micro copy no longer renders beside the card — it is the
    // card's cause fallback; standalone copy stays for the empty claim.
    expect(src).toMatch(/\{!shown\.failed && copy \? \(/);
  });

  test('the skeleton window and the check rows stay put', () => {
    const src = healthPane();
    expect(src).toMatch(/\{!shown\.loaded && !shown\.failed \? \(/);
    expect(src).toMatch(/shown\.checks\.map\(/);
    expect(src).toContain('healthChecksListCopy(shown)');
    expect(src).toContain("gatewayRequest('doctor.memory.status', {})");
  });
});

describe('the paired-devices pane keeps the thrown message and answers with an ErrorCard', () => {
  test('the catch stores the caught message and a parsed read clears it', () => {
    const src = devicesPane();
    expect(src).toMatch(
      /catch \(caught\) \{\s*fold\(\{ ok: false \}\);\s*setError\(caught instanceof Error \? caught\.message : String\(caught\)\);\s*\}/,
    );
    expect(src).toMatch(
      /const read = pairedDevicesReadFromUnknown\(payload\);\s*fold\(read\);\s*if \(read\.ok\) setError\(null\);/,
    );
  });

  test('a failed read renders the ErrorCard with the kept cause and a Retry wired to load', () => {
    const src = devicesPane();
    expect(src).toMatch(/\{shown\.failed \? \(\s*<ErrorCard/);
    expect(src).toMatch(/cause=\{error \?\? copy \?\? 'Paired devices could not be read\.'\}/);
    expect(src).toMatch(/onRetry=\{\(\) => void load\(\)\}/);
    expect(src).not.toMatch(/label="Retry"/);
    expect(src).toMatch(/\{!shown\.failed && copy \? \(/);
  });

  test('the skeleton window, the device rows, and the revoke flow stay put', () => {
    const src = devicesPane();
    expect(src).toMatch(/\{!shown\.loaded && !shown\.failed \? \(/);
    expect(src).toMatch(/shown\.devices\.map\(/);
    expect(src).toContain('pairedDevicesListCopy(shown)');
    expect(src).toMatch(/onConfirm=\{executeRevoke\}/);
    expect(src).toContain("gatewayRequest('device.revoke', { deviceId: target })");
  });
});

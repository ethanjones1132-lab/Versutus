declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSection(): string {
  return readSource(['src', 'components', 'gateway', 'providers-section.tsx']);
}

function errorCardBlock(src: string): string {
  const start = src.indexOf('<ErrorCard');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('/>', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// The disconnected ErrorCard names "Connect to the Gate first." but its Retry
// only re-called load(), which re-sets the same error — a dead control. Retry
// on that card now re-runs the connect cycle (retryAutoConnect, the same
// affordance Home's ErrorCard and "Retry connection" already use); the
// connected refusal — a failed providers.list call — still retries the read.
describe('providers section disconnected retry', () => {
  test('retryAutoConnect comes from useGateway alongside status and gatewayRequest', () => {
    const src = readSection();
    expect(src).toContain('const { status, gatewayRequest, retryAutoConnect } = useGateway();');
  });

  test('the ErrorCard Retry branches on connection status', () => {
    const card = errorCardBlock(readSection());
    expect(card).toContain("if (status === 'connected') {");
    expect(card).toContain('} else {');
  });

  test('connected Retry still re-reads, disconnected Retry re-runs the connect cycle', () => {
    const card = errorCardBlock(readSection());
    const loadAt = card.indexOf('void load();');
    const retryAt = card.indexOf('void retryAutoConnect();');
    expect(loadAt).toBeGreaterThanOrEqual(0);
    expect(retryAt).toBeGreaterThan(loadAt);
    // Exactly one onRetry — the ErrorCard is the only Retry in the section.
    expect((card.match(/onRetry=/g) ?? []).length).toBe(1);
  });

  test('the disconnected guard still short-circuits load with the connect message', () => {
    const src = readSection();
    expect(src).toContain("if (status !== 'connected') {");
    expect(src).toContain("setError('Connect to a Gate to manage providers.');");
  });

  test('ErrorCard cause/affected/next copy is byte-identical', () => {
    const src = readSection();
    expect(src).toContain('cause={error}');
    expect(src).toContain('affected="Providers on this Gate"');
    expect(src).toContain(
      "next={status === 'connected' ? 'Retry, or check the Gate log for the failing call.' : 'Connect to the Gate first.'}",
    );
  });

  test('retryAutoConnect forgives the failure streak and re-runs the connect cycle', () => {
    const provider = readSource(['src', 'context', 'gateway-provider.tsx']);
    const start = provider.indexOf('const retryAutoConnect = useCallback(async () => {');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = provider.slice(start, start + 500);
    expect(body).toContain('autoRetryFailureStreakRef.current = 0;');
    expect(body).toContain('await runAutoConnectCycle();');
  });
});

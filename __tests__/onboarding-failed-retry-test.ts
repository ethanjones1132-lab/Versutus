declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readScreen(): string {
  return readSource(['src', 'components', 'onboarding', 'onboarding-screen.tsx']);
}

// First-run auto-connect failure parks the phase in 'failed' and redirects
// here (AppBootstrap), and the probe message says "Tap retry or check your
// gateway address." — but the screen rendered that message as plain text with
// no Retry, and the Connect CTA stays disabled until an address validates, so
// with an empty field there was no tap anywhere. The failed state now offers a
// Retry wired to retryAutoConnect — the same auto-connect retry Home's
// Try-again button fires — while the typed Connect path and its API-key field
// are untouched.
describe('onboarding failed auto-connect retry', () => {
  test('retryAutoConnect comes from useGateway alongside the onboarding state', () => {
    const src = readScreen();
    expect(src).toContain(
      'const { setupFromPcAddress, probeMessage, connectionPhase, settings, retryAutoConnect } = useGateway();',
    );
  });

  test('a Retry button wired to retryAutoConnect renders only in the failed phase', () => {
    const src = readScreen();
    expect(src).toContain("probeMessage && !busy && connectionPhase === 'failed'");
    expect(src).toContain('<Button label="Retry" onPress={() => void retryAutoConnect()} />');
  });

  test('the probe-message status card still renders the message as plain text', () => {
    const src = readScreen();
    const start = src.indexOf('probeMessage && !busy');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = src.slice(start, start + 1200);
    expect(block).toContain('<Text color="secondary">{probeMessage}</Text>');
  });

  test('the typed Connect path is intact: setupFromPcAddress with the validation gate', () => {
    const src = readScreen();
    expect(src).toContain('const ok = await setupFromPcAddress(pcAddress, token);');
    expect(src).toContain('disabled={cta.locked || !validation.valid}');
  });

  test('the API-key field keeps its label and secure entry', () => {
    const src = readScreen();
    expect(src).toContain('Gateway API key');
    expect(src).toContain('secureTextEntry');
  });

  test('the typed-path ErrorCard still retries handleContinue with Try again', () => {
    const src = readScreen();
    expect(src).toContain('onRetry={() => void handleContinue()}');
    expect(src).toContain('retryLabel="Try again"');
  });

  test('the Connect CTA still derives from the wizard, not the failed phase', () => {
    const src = readScreen();
    expect(src).toContain('const cta = deriveWizardCta(working, connectionPhase);');
    expect(src).toContain('label={cta.label}');
  });
});

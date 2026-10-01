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

  test('a Retry button wired to the busy-aware handler renders in the failed phase and through the retry', () => {
    const src = readScreen();
    // The ladder parks the phase in 'searching' before its first await, and
    // that makes `busy` true — so the tap's own flag has to carry the button
    // through the whole run, while every other case still hides on `busy`.
    expect(src).toContain("probeMessage && (retrying || (!busy && connectionPhase === 'failed'))");
    expect(src).not.toContain("probeMessage && !busy && connectionPhase === 'failed'");
    // ONB-1: the button used to fire `void retryAutoConnect()` — a cycle with
    // no `catch` inside it, with no busy state and no result on screen. The
    // handler now says while it runs and what came of it.
    expect(src).toContain("label={retrying ? 'Retrying…' : 'Retry'}");
    expect(src).toContain('onPress={() => void handleRetry()}');
    expect(src).toContain('disabled={retrying}');
    expect(src).toContain('await retryAutoConnect();');
  });

  test('a second tap inside one frame cannot start a second cycle', () => {
    const src = readScreen();
    expect(src).toContain('if (retryingRef.current) return;');
    expect(src).toContain('retryingRef.current = true;');
  });

  test('a cycle that ends in failed names itself in the error card', () => {
    const src = readScreen();
    // `probeMessage` still carries the words from BEFORE the tap, so the
    // verdict is judged where the phase is committed — in an effect.
    expect(src).toContain("if (connectionPhase !== 'failed') return;");
    expect(src).toContain('setError(\n');
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
    expect(src).toContain('const result = await setupFromPcAddress(pcAddress, token);');
    expect(src).toContain("if (result.kind === 'connected')");
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

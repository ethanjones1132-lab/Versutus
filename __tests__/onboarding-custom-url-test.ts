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

function readValidator(): string {
  return readSource(['src', 'lib', 'onboarding', 'validate-pc-address.ts']);
}

// validatePcAddress accepts only a Tailscale hostname, tailnet/LAN IP and
// optional :port — a ws:// or http:// URL is refused at the address field, so
// a first-run OpenClaw/custom-URL install dead-ended on onboarding. The manual
// add sheet (/gateway/add) is onboarding-exempt (route-guard.ts) and already
// canonicalizes full URLs via normalizeGatewayUrl — it just had no way to be
// reached from onboarding. The screen now offers one link that opens it, while
// the hostname/IP typed Connect path and the validator's octet/hostname split
// are byte-identical.
describe('onboarding custom gateway URL affordance', () => {
  test('a link opens the manual add sheet with router.push', () => {
    const src = readScreen();
    expect(src).toContain("router.push('/gateway/add')");
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the copy names a custom URL with a scheme example', () => {
    const src = readScreen();
    expect(src).toContain('custom URL');
    expect(src).toContain('ws://');
  });

  test('the link lives in the form card, after the API-key field and before the status cards', () => {
    const src = readScreen();
    const linkAt = src.indexOf("router.push('/gateway/add')");
    expect(linkAt).toBeGreaterThanOrEqual(0);
    const apiKeyFieldAt = src.indexOf('Optional when the gateway is configured without authentication.');
    const statusCardAt = src.indexOf('probeMessage && !busy');
    expect(apiKeyFieldAt).toBeGreaterThanOrEqual(0);
    expect(statusCardAt).toBeGreaterThanOrEqual(0);
    expect(linkAt).toBeGreaterThan(apiKeyFieldAt);
    expect(linkAt).toBeLessThan(statusCardAt);
  });

  test('the validator still refuses schemes: no scheme handling added', () => {
    const src = readValidator();
    expect(src).not.toContain('http://');
    expect(src).not.toContain('ws://');
  });

  test('the validator keeps its dotted-decimal-first octet/hostname split', () => {
    const src = readValidator();
    const ipBranch = src.indexOf('tailnetIpPattern.test(withoutPort) || lanIpPattern.test(withoutPort)');
    const hostnameBranch = src.indexOf('hostnamePattern.test(withoutPort)');
    expect(ipBranch).toBeGreaterThanOrEqual(0);
    expect(hostnameBranch).toBeGreaterThan(ipBranch);
  });

  test('the hostname/IP typed Connect path is intact', () => {
    const src = readScreen();
    expect(src).toContain('const ok = await setupFromPcAddress(pcAddress, token);');
    expect(src).toContain('disabled={cta.locked || !validation.valid}');
    expect(src).toContain('placeholder="ethanspc.tail3a1a8a.ts.net"');
  });

  test('the typed-path ErrorCard and wizard Connect CTA are untouched', () => {
    const src = readScreen();
    expect(src).toContain('onRetry={() => void handleContinue()}');
    expect(src).toContain('const cta = deriveWizardCta(working, connectionPhase);');
    expect(src).toContain('label={cta.label}');
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const read = (...parts: string[]) =>
  fs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');

const onboarding = read('src', 'components', 'onboarding', 'onboarding-screen.tsx');
const provider = read('src', 'context', 'gateway-provider.tsx');
const pairing = read('src', 'components', 'pairing-panel.tsx');

test('(a) fresh install: one form connects with a key or pairs without one', () => {
  expect(onboarding).toContain('Connect to your PC');
  expect(onboarding).toContain('Leave blank to pair instead');
  expect(onboarding.indexOf('Gateway key')).toBeGreaterThan(onboarding.indexOf('PC address'));
});

test('(b) pending Gate pairing tells where to approve and polls to completion', () => {
  expect(onboarding).toMatch(/pairingPending\s*\?\s*\([\s\S]*?<PairingPanel deviceId=\{deviceId\} pairingDetails=\{pairingDetails\} \/>/);
  expect(pairing).toContain('Approve this phone on your PC');
  expect(pairing).toContain('On your PC, open http://localhost:8760/pair and click Approve.');
  expect(onboarding).toContain('On your PC, open http://localhost:8760/pair and click Approve.');
  expect(pairing).toContain('node gate/cli.mjs pair list');
  expect(provider).toMatch(/timer\s*=\s*setTimeout\(\(\)\s*=>\s*void poll\(\),\s*3000\)/);
  expect(provider).toMatch(/result\.status\s*===\s*'granted'\s*&&\s*result\.token/);
  expect(provider).toContain('await connectGatewayRef.current(repaired)');
});

test('(c) a rejected saved Gate grant keeps its profile and opens same-PC pairing', () => {
  expect(provider).toContain("This phone's access was reset.");
  expect(provider).toContain('const repaired = { ...gateway, token: result.token };');
  expect(provider).toContain('Approve this phone on your PC. Run node gate/cli.mjs pair list');
  expect(provider).toContain('setPairingRecovery({ gateway, identity: identityForClient });');
  expect(provider).not.toContain('removeGateway(gateway.id)');
});

test('(d) Tailscale outage names Tailscale; the error card keeps its one retry', () => {
  expect(onboarding).toContain('100 && octets[1] >= 64 && octets[1] <= 127');
  expect(onboarding).toContain('Turn on Tailscale on this phone, then try again.');
  expect(onboarding).toContain("Linking.openURL('tailscale://')");
  // The ErrorCard's own retry is the one retry action; the Connect button stays.
  expect(onboarding).toContain('onRetry={() => void handleContinue()}');
  expect(onboarding).not.toContain('label="Retry"');
  expect(provider).toContain("Versutus isn't running on ${pcName}");
});

test('(e) a proven saved MagicDNS profile can be updated in one tap', () => {
  expect(provider).toContain('addressMatch.url !== probeResult.url');
  expect(provider).toContain('/\\.ts\\.net(?:[:/]|$)/i.test(addressMatch.url)');
  expect(provider).toContain('const updated = { ...pending.gateway, url: pending.address };');
  expect(onboarding).toContain('label="Use the new address"');
});

test('offline gateways do not report an unsupported Bot capability', () => {
  expect(provider).toContain("if (!client || statusRef.current !== 'connected') return false;");
  expect(provider).toContain("setLastError('This gateway does not expose bots.');");
});

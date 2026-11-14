import { needsGatewayOnboarding } from '@/lib/onboarding/bootstrap';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

function providerSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP),
    'utf8',
  );
}

describe('first-run gateway onboarding', () => {
  const cleanSettings = { onboardingComplete: false, tailscaleHost: undefined };

  test('a clean install with no saved gateway stays in onboarding', () => {
    expect(
      needsGatewayOnboarding({
        settings: cleanSettings,
        savedGatewayCount: 0,
      }),
    ).toBe(true);
  });

  test('a saved gateway preserves the existing install path', () => {
    expect(
      needsGatewayOnboarding({
        settings: cleanSettings,
        savedGatewayCount: 1,
      }),
    ).toBe(false);
    expect(
      needsGatewayOnboarding({
        settings: cleanSettings,
        savedGatewayCount: 0,
      }),
    ).toBe(true);
  });

  test('an interrupted explicit setup reopens onboarding even if its profile was saved before restart', () => {
    expect(
      needsGatewayOnboarding({
        settings: {
          onboardingComplete: false,
          tailscaleHost: 'pc.tailnet.ts.net',
          manualSetupPending: true,
        },
        savedGatewayCount: 1,
      }),
    ).toBe(true);
  });

  test('a saved address from an interrupted setup does not count as a completed connection', () => {
    expect(
      needsGatewayOnboarding({
        settings: { onboardingComplete: false, tailscaleHost: 'pc.tailnet.ts.net' },
        savedGatewayCount: 0,
      }),
    ).toBe(true);
  });

  test('a completed setup never reopens onboarding', () => {
    expect(
      needsGatewayOnboarding({
        settings: { onboardingComplete: true, tailscaleHost: undefined },
        savedGatewayCount: 0,
      }),
    ).toBe(false);
  });

  test('bootstrap keeps the clean-install decision while auto-connect finds no candidates', () => {
    const source = providerSource();
    const bootstrap = source.slice(source.indexOf('const bootstrap = useCallback'));
    const keepDecisionAt = bootstrap.indexOf('setNeedsOnboarding(onboardingNeeded);');
    const startAutoConnectAt = bootstrap.indexOf('void runAutoConnect(loadedSettings, roster, rosterActiveId)');

    expect(keepDecisionAt).toBeGreaterThanOrEqual(0);
    expect(startAutoConnectAt).toBeGreaterThan(keepDecisionAt);
  });

  test('bootstrap completes first-run onboarding only after auto-connect reports a live connection', () => {
    const source = providerSource();
    const bootstrap = source.slice(source.indexOf('const bootstrap = useCallback'));
    const autoConnectAt = bootstrap.indexOf('void runAutoConnect(loadedSettings, roster, rosterActiveId)');
    const connectedGuardAt = bootstrap.indexOf("statusRef.current === 'connected'");
    const ownershipGuardAt = bootstrap.indexOf('explicitSetupAttemptRef.current === bootstrapSetupAttempt');
    const markCompleteAt = bootstrap.indexOf('await markOnboardingComplete();', connectedGuardAt);

    expect(autoConnectAt).toBeGreaterThanOrEqual(0);
    expect(connectedGuardAt).toBeGreaterThan(autoConnectAt);
    expect(ownershipGuardAt).toBeGreaterThan(autoConnectAt);
    expect(bootstrap).toContain('!explicitSetupInFlightRef.current');
    expect(bootstrap).toContain('explicitSetupAttemptRef.current !== bootstrapSetupAttempt');
    expect(bootstrap).toContain('explicitSetupPendingRef.current = loadedSettings.manualSetupPending === true');
    expect(markCompleteAt).toBeGreaterThan(connectedGuardAt);
  });

  test('an explicit saved address remains incomplete until the connection succeeds', () => {
    const source = providerSource();
    const setup = source.slice(source.indexOf('const setupFromPcAddress = useCallback'));
    const saveAddressAt = setup.indexOf('const nextSettings = await saveAppSettings({');
    const probeAt = setup.indexOf('probeHighPriorityCandidates(');
    const connectAt = setup.indexOf('await connectGateway(gateway);');
    const connectedGuardAt = setup.indexOf("if (statusRef.current === 'connected')", connectAt);
    const markCompleteAt = setup.indexOf('await markOnboardingComplete();', connectedGuardAt);

    expect(saveAddressAt).toBeGreaterThanOrEqual(0);
    expect(setup.slice(saveAddressAt, probeAt)).not.toContain('onboardingComplete: true');
    expect(connectAt).toBeGreaterThan(probeAt);
    expect(connectedGuardAt).toBeGreaterThan(connectAt);
    expect(markCompleteAt).toBeGreaterThan(connectedGuardAt);
  });
});

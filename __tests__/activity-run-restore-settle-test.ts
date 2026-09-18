declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readProvider(): string {
  return nodeFs.readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

// Restored unresolved runs must be reconciled on the first successful Gateway
// connection, not only after a later disconnect. The onStatus handler for
// 'connected' must call settleUnresolvedRuns when the gateway first connects
// (not just onHealthCheck during reconnect). The onHealthCheck path already
// does this for reconnects but explicitly returns early on firstConnect.
// Pinned off the provider source the way the other suites do.
describe('restored unresolved runs settle on first connect', () => {
  const provider = readProvider();

  test('onStatus connected handler calls settleUnresolvedRuns for the active gateway', () => {
    // The onStatus callback for 'connected' must trigger settlement of
    // unresolved runs. It should run after the push registration sync (which
    // already guards on nextStatus === 'connected' && gateway.kind === 'custom')
    // and use the current client to re-poll unresolved runs.
    const connectedGuardIdx = provider.indexOf("if (nextStatus === 'connected' && gateway.kind === 'custom')");
    expect(connectedGuardIdx).toBeGreaterThan(-1);
    const connectedBlock = provider.slice(
      connectedGuardIdx,
      provider.indexOf('onHello:', connectedGuardIdx)
    );
    expect(connectedBlock).toContain('settleUnresolvedRuns');
    expect(connectedBlock).toContain('activityRunsRef.current');
  });

  test('onStatus connected settlement runs for custom gateways only', () => {
    // The settlement should be scoped to custom gateways (same as push sync),
    // because only those expose getRunStatus.
    const connectedGuardIdx = provider.indexOf("if (nextStatus === 'connected' && gateway.kind === 'custom')");
    expect(connectedGuardIdx).toBeGreaterThan(-1);
    const connectedBlock = provider.slice(
      connectedGuardIdx,
      provider.indexOf('onHello:', connectedGuardIdx)
    );
    expect(connectedBlock).toContain("gateway.kind === 'custom'");
  });

  test('onStatus connected settlement uses the same client as push sync', () => {
    // The settlement and push sync should share the same client reference
    // so they operate on the same gateway connection.
    const connectedGuardIdx = provider.indexOf("if (nextStatus === 'connected' && gateway.kind === 'custom')");
    expect(connectedGuardIdx).toBeGreaterThan(-1);
    const connectedBlock = provider.slice(
      connectedGuardIdx,
      provider.indexOf('onHello:', connectedGuardIdx)
    );
    expect(connectedBlock).toContain('syncPushRegistration');
    expect(connectedBlock).toContain('settleUnresolvedRuns');
  });

  test('onHealthCheck firstConnect path does not settle (reconnect path does)', () => {
    // The existing onHealthCheck path handles reconnects (not firstConnect).
    // This test ensures we don't duplicate the settlement there.
    const healthCheckBlock = provider.slice(
      provider.indexOf('onHealthCheck:'),
      provider.indexOf('onPairingRequired:', provider.indexOf('onHealthCheck:'))
    );
    const firstConnectGuard = healthCheckBlock.indexOf('firstConnect');
    expect(firstConnectGuard).toBeGreaterThan(-1);
    // The firstConnect path should return early without calling settleUnresolvedRuns
    const firstConnectBlock = healthCheckBlock.slice(firstConnectGuard);
    const earlyReturn = firstConnectBlock.indexOf('return;');
    expect(earlyReturn).toBeGreaterThan(-1);
    const settleCall = firstConnectBlock.indexOf('settleUnresolvedRuns');
    // settleUnresolvedRuns should only appear after the firstConnect early return
    // (in the reconnect section), not in the firstConnect block itself
    const reconnectSection = firstConnectBlock.slice(earlyReturn);
    expect(reconnectSection).toContain('settleUnresolvedRuns');
  });
});
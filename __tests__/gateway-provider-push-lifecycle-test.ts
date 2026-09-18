// ─── Push registration lifecycle across every way a Gate is left (Solution A4)
// A connected Gate keeps a push row keyed by this device's grant. Leaving it —
// switching to another gateway, or an explicit disconnect — must tell the Gate
// to forget the token before the outgoing client is discarded, so a "left" Gate
// cannot keep notifying the phone. The connect path already registers once per
// connection, so reconnecting the same Gate re-registers. The wiring is pinned
// off the source, the way the rest of the provider suites pin theirs: a
// refactor that drops the deregistration on either teardown fails here, not on
// the phone.

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

const provider = readSource('src', 'context', 'gateway-provider.tsx');

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = provider.indexOf(startMarker);
  const end = provider.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return provider.slice(start, end);
}

const attach = sliceBetween(
  'const attachClient = useCallback',
  'const connectGateway = useCallback',
);
const disconnectFn = sliceBetween(
  'const disconnectGateway = useCallback',
  'const sendMessage = useCallback',
);

describe('push registration lifecycle', () => {
  test('an attach that supersedes a Gate deregisters it before discarding the client', () => {
    // The outgoing client is captured before the supersede bumps the generation.
    expect(attach).toContain('const leaving = clientRef.current;');
    const deregisterAt = attach.indexOf('await deregisterWithGate(leaving)');
    expect(deregisterAt).toBeGreaterThan(-1);
    // The deregistration lands before the old client is discarded.
    const disconnectAt = attach.indexOf('clientRef.current?.disconnect();');
    expect(disconnectAt).toBeGreaterThan(deregisterAt);
  });

  test('the attach deregistration is Gate-only, best-effort, and supersede-safe', () => {
    // Only a Gate the manifest flow identified has a push row; Hermes and
    // OpenClaw are never told to forget a token they never registered.
    expect(attach).toContain("leavingKind === 'custom'");
    const deregisterAt = attach.indexOf('await deregisterWithGate(leaving)');
    const after = attach.slice(deregisterAt);
    // A Gate that is already unreachable is still switched away from.
    expect(after).toContain('catch {');
    // If a newer attach superseded us while we awaited, it owns the teardown.
    expect(after).toContain('if (!isCurrent()) return;');
  });

  test('an explicit disconnect deregisters the Gate before discarding the client', () => {
    const deregisterAt = disconnectFn.indexOf('void deregisterWithGate(leaving)');
    expect(deregisterAt).toBeGreaterThan(-1);
    const disconnectAt = disconnectFn.indexOf('clientRef.current?.disconnect();');
    expect(disconnectAt).toBeGreaterThan(deregisterAt);
  });

  test('the disconnect deregistration is Gate-only and best-effort', () => {
    expect(disconnectFn).toContain("activeGatewayRef.current?.kind === 'custom'");
    const deregisterAt = disconnectFn.indexOf('void deregisterWithGate(leaving)');
    // The fired RPC never rejects the disconnect path on an unreachable Gate.
    expect(disconnectFn.slice(deregisterAt)).toContain('.catch(() => undefined);');
  });

  test('reconnecting a Gate still registers the fresh token', () => {
    // The connect-time registration is untouched by the teardown additions.
    expect(provider).toContain("nextStatus === 'connected' && gateway.kind === 'custom'");
    expect(provider).toContain('void syncPushRegistration(client)');
  });
});
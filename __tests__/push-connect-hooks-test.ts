// ─── Push registration on connect, deregistration on removal (Solution A4) ─
// The app hands its Expo push token to the Gate once per connection — initial
// and every reconnect — without ever stalling or breaking the connection, and
// tells the Gate to forget the token when the gateway profile is removed. The
// wiring is pinned off the source, the way every provider suite here pins it:
// a refactor that drops either call fails here, not on the phone.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
const registration = () => readSource('src', 'lib', 'notifications', 'push-registration.ts');

describe('push connect hooks', () => {
  test('the provider imports the registration module', () => {
    expect(provider()).toContain(
      "from '@/lib/notifications/push-registration'",
    );
    expect(provider()).toContain('syncPushRegistration');
    expect(provider()).toContain('deregisterWithGate');
  });

  test('a custom-gateway connection registers without blocking it', () => {
    const source = provider();
    expect(source).toContain("nextStatus === 'connected' && gateway.kind === 'custom'");
    expect(source).toContain('void syncPushRegistration(client)');
  });

  test('removing the active custom gateway deregisters before disconnect', () => {
    const source = provider();
    const deregisterAt = source.indexOf('await deregisterWithGate(leaving)');
    expect(deregisterAt).toBeGreaterThan(-1);
    const disconnectAt = source.indexOf('leaving?.disconnect()');
    expect(disconnectAt).toBeGreaterThan(deregisterAt);
  });

  test('registration itself never rejects the connect path', () => {
    const source = registration();
    expect(source).toContain('await registerWithGate(rpc, token)');
    // The register call sits inside a try — a Gate that refuses the RPC
    // (unpaired grant, older build) just means no relay, never a dead connect.
    const callAt = source.indexOf('await registerWithGate(rpc, token)');
    const fnAt = source.indexOf('export async function syncPushRegistration');
    const segment = source.slice(fnAt, callAt);
    expect(segment).toContain('try {');
  });
});

import { connectionErrorShown } from '@/lib/connection/stale-error';

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

describe('a connection error may not outlive the connection', () => {
  it('shows the failure while the gateway is not answering', () => {
    expect(connectionErrorShown('disconnected', 'HTTP 401: unauthorized')).toBe(
      'HTTP 401: unauthorized',
    );
    expect(connectionErrorShown('reconnecting', 'HTTP 401: unauthorized')).toBe(
      'HTTP 401: unauthorized',
    );
    expect(connectionErrorShown('pairing', 'needs approval')).toBe('needs approval');
  });

  it('drops a failure the live connection has already disproved', () => {
    // The card this feeds says "The API key or token was refused. Affected:
    // gateway connection. Next: open gateway setup and update the token."
    // A gateway that is answering has refused nothing, so the card is a lie —
    // and it sends the operator to re-enter a token that works. Observed on
    // 2026-09-16: CONNECTED and that card on screen together, because the
    // client's `onError` channel writes lastError at any time (including a
    // Gate restart) while the phase rule only clears it on the transition
    // INTO connected.
    expect(connectionErrorShown('connected', 'HTTP 401: unauthorized')).toBeNull();
  });

  it('has nothing to show when nothing failed', () => {
    expect(connectionErrorShown('connected', null)).toBeNull();
    expect(connectionErrorShown('disconnected', null)).toBeNull();
    expect(connectionErrorShown('disconnected', '')).toBeNull();
  });

  it('is the rule the Home dashboard actually renders through', () => {
    const dashboard = readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');
    expect(dashboard).toContain("from '@/lib/connection/stale-error'");
    expect(dashboard).toContain('connectionErrorShown(status, lastError)');
  });
});

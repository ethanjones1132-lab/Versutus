declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readScreen(): string {
  return readSource(['src', 'components', 'terminal', 'terminal-screen.tsx']);
}

// With a saved gateway that is not connected, the RPC/Agent command list's
// ListEmptyComponent was caption-only ('Connect to the gateway to run
// commands.') — the same dead end the Activity 'Connect to start runs' empty
// used to be. The empty now renders an EmptyState whose Reconnect fires
// retryAutoConnect, the same auto-connect retry the no-gateway
// ChatEmptyState, Home, chat, and providers already wire; the connected
// branch keeps its plain caption exactly as before.
describe('terminal disconnected empty state', () => {
  test('retryAutoConnect is destructured from useGateway', () => {
    const src = readScreen();
    expect(src).toContain('retryAutoConnect,');
    expect(src).toContain('} = useGateway();');
  });

  test('the disconnected empty offers Reconnect wired to retryAutoConnect', () => {
    const src = readScreen();
    expect(src).toContain('actionLabel="Reconnect"');
    expect(src).toContain('onAction={() => void retryAutoConnect()}');
  });

  test('the empty branches on connection status', () => {
    const src = readScreen();
    expect(src).toContain('ListEmptyComponent={');
    expect(src).toContain("status === 'connected' ? (");
    // The Reconnect action is gated to the disconnected branch only.
    expect(src.indexOf('actionLabel="Reconnect"')).toBeGreaterThan(src.indexOf("status === 'connected' ? ("));
  });

  test('the disconnected copy stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('Connect to the gateway to run commands.');
  });

  test('the connected empty copy stays byte-identical with no action of its own', () => {
    const src = readScreen();
    expect(src).toContain('Run a command to inspect or control the live gateway.');
    // The Reconnect action lives only in the disconnected branch — exactly
    // one Reconnect in the whole screen, so the connected branch renders
    // none. ('Use Gateway RPC' is the shell-unavailable empty's own action.)
    expect(src.match(/actionLabel="Reconnect"/g)?.length).toBe(1);
    expect(src).toContain('actionLabel="Use Gateway RPC"');
  });

  // The connected-idle branch was a bare tertiary Text — less structure than
  // its own disconnected twin at :411-417. It now uses the same EmptyState
  // idiom (icon, headline, guidance), carrying the old copy as its
  // description so the sentence the pins rely on stays byte-identical.
  test('the connected idle branch is an EmptyState, not a bare caption', () => {
    const src = readScreen();
    const connectedIdx = src.indexOf("status === 'connected' ? (");
    const reconnectIdx = src.indexOf('actionLabel="Reconnect"', connectedIdx);
    expect(connectedIdx).toBeGreaterThan(-1);
    expect(reconnectIdx).toBeGreaterThan(connectedIdx);
    const connectedBranch = src.slice(connectedIdx, reconnectIdx);
    expect(connectedBranch).toContain('<EmptyState');
    expect(connectedBranch).toContain('description="Run a command to inspect or control the live gateway."');
    expect(connectedBranch).not.toContain('color="tertiary"');
    expect(connectedBranch).not.toContain('actionLabel=');
  });

  test('the no-gateway ChatEmptyState wiring is untouched', () => {
    const src = readScreen();
    expect(src).toContain('onConnect={() => void retryAutoConnect()}');
    expect(src).toContain("onGoHome={() => router.replace('/')}");
  });

  test('EmptyState renders its button only when both action props are set', () => {
    const src = readSource(['src', 'components', 'ui', 'EmptyState.tsx']);
    expect(src).toContain('{actionLabel && onAction ? (');
  });
});

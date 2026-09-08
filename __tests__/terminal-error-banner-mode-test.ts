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

// In RPC/Agent mode a refused gateway command set terminalError, and the
// banner rendered on terminalError && shellReady with no mode check — so a
// failed RPC/Agent command on a shell-capable gateway offered
// "Retry terminal", which opens a background shell session instead of
// retrying the command and clears the banner as if recovered. The banner now
// renders in shell mode only; the RPC/Agent failure still lands in the
// command summary the panel already shows.
describe('terminal error banner mode gate', () => {
  test('the banner renders in shell mode only', () => {
    const src = readScreen();
    expect(src).toContain("{terminalError && shellReady && mode === 'shell' ? (");
  });

  test('the runGatewayCommand catch still sets the command-failed summary', () => {
    const src = readScreen();
    expect(src).toContain('setTerminalError(message);');
    expect(src).toContain('setCommandOutput(`Command failed: ${message}`);');
    expect(src).toContain('setCommandLog(message);');
  });

  test('the panel still receives the summary as lastSummary', () => {
    const src = readScreen();
    expect(src).toContain('lastSummary={commandOutput || undefined}');
  });

  test('the shell-mode banner copy and retry stay byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('retryLabel="Retry terminal"');
    expect(src).toContain('onRetry={() => void startTerminal()}');
    expect(src).toContain('next="Retry the session or ensure the gateway is connected."');
  });

  test('the shell error setters stay byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('onError: (message) => {\n            setTerminalError(message);\n            setTerminalConnected(false);\n          }');
    expect(src).toContain('setTerminalError(error instanceof Error ? error.message : String(error));');
  });

  test('the shell pane still gates on shell mode', () => {
    const src = readScreen();
    expect(src).toContain("{mode === 'shell' && shellSupport !== 'ready' ? (");
  });
});

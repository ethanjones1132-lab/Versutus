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

// The ErrorCard used to render only on `terminalError && shellReady &&
// mode === 'shell'`, so the default RPC/Agent modes surfaced a refused
// command as `Command failed: …` caption text with no affected/next
// guidance — while the shell-only gate existed because "Retry terminal"
// opens a background shell instead of retrying the command. The card now
// renders whenever terminalError is set; mode only picks the copy and the
// retry (shell keeps its session retry, RPC/Agent re-runs the failed
// command), so command modes never offer a shell retry.
describe('terminal error card mode coverage', () => {
  test('the ErrorCard renders whenever terminalError is set, not shell-gated', () => {
    const src = readScreen();
    expect(src).toContain('{terminalError ? (');
    expect(src).not.toContain("terminalError && shellReady && mode === 'shell'");
  });

  test('the runGatewayCommand catch still sets the command-failed summary', () => {
    const src = readScreen();
    expect(src).toContain('setTerminalError(message);');
    expect(src).toContain('setCommandOutput(`Command failed: ${message}`);');
    expect(src).toContain('setCommandLog(message);');
  });

  test('the runGatewayCommand catch records the failed command for a retry', () => {
    const src = readScreen();
    expect(src).toContain('setLastFailedCommand(command);');
    expect(src.indexOf('setLastFailedCommand(command);')).toBeGreaterThan(
      src.indexOf('const message = error instanceof Error ? error.message : String(error);'),
    );
  });

  test('the panel still receives the summary as lastSummary', () => {
    const src = readScreen();
    expect(src).toContain('lastSummary={commandOutput || undefined}');
  });

  test('the shell-mode banner copy and retry stay byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('retryLabel="Retry terminal"');
    expect(src).toContain('() => void startTerminal()');
    expect(src).toContain('next="Retry the session or ensure the gateway is connected."');
    expect(src).toContain('affected={`${modeLabel.toLowerCase()} session`}');
  });

  test('command modes get a command retry wired to the failed command, not a shell retry', () => {
    const src = readScreen();
    expect(src).toContain('retryLabel="Retry command"');
    expect(src).toContain('onRetry={lastFailedCommand ? () => void runGatewayCommand(lastFailedCommand) : undefined}');
    // Exactly one shell retry in the whole screen — the shell branch's.
    expect(src.match(/retryLabel="Retry terminal"/g)).toHaveLength(1);
    expect(src.match(/retryLabel="Retry command"/g)).toHaveLength(1);
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

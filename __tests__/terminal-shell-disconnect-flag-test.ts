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

// The gateway/status cleanup closed the live shell session but left the
// terminalConnected flag true, so the Shell header caption and banner dot
// kept reading "live"/green while the ConnectionBadge beside them reported
// disconnected. The cleanup now clears the flag.
describe('terminal shell disconnect flag', () => {
  test('the gateway/status cleanup clears terminalConnected', () => {
    const src = readScreen();
    const cleanup = src.match(
      /useEffect\(\(\) => \{\s*return \(\) => \{[\s\S]*?\};\s*\}, \[gatewayId, status\]\);/,
    )?.[0];
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain('sessionRef.current?.close()');
    expect(cleanup).toContain('sessionRef.current = null');
    expect(cleanup).toContain('setTerminalConnected(false)');
  });

  test('the reconnect effect still restarts the session untouched', () => {
    const src = readScreen();
    expect(src).toContain(
      "if (gatewayId && status === 'connected' && shellReady && mode === 'shell' && !sessionRef.current)",
    );
    expect(src).toContain('void startTerminal();');
    expect(src).toMatch(/}, \[gatewayId, mode, shellReady, startTerminal, status\]\);/);
  });

  test('the header caption still reads the flag', () => {
    const src = readScreen();
    expect(src).toContain(
      "{modeLabel} · {mode === 'shell' && shellReady ? (terminalConnected ? 'live' : 'starting…') : status}",
    );
  });

  test('the banner dot still reads the flag', () => {
    const src = readScreen();
    expect(src).toContain('terminalConnected ? tokens.statusConnected : tokens.statusConnecting');
    expect(src).toContain("terminalConnected\n                  ? 'connected'");
  });

  test('the onError and onExit false-setters stay byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('onError: (message) => {\n            setTerminalError(message);\n            setTerminalConnected(false);\n          }');
    expect(src).toContain('appendOutput(`\\n[exit ${code}]\\n`);\n            sessionRef.current = null;\n            setTerminalConnected(false);');
  });

  test('the startTerminal reset still clears the flag first', () => {
    const src = readScreen();
    expect(src).toContain('setTerminalLines([]);\n    setTerminalError(null);\n    setTerminalConnected(false);');
  });
});

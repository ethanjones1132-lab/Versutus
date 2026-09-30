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

// The cleanup effect closed the live shell session on ANY status flip (a
// health blip -> reconnecting -> connected), killing a healthy stream. It now
// closes only on gateway change or unmount.
describe('terminal shell disconnect flag', () => {
  test('the cleanup effect closes only on gateway change, not status blips', () => {
    const src = readScreen();
    const cleanup = src.match(
      /useEffect\(\(\) => \{\s*return \(\) => \{[\s\S]*?\};\s*\}, \[gatewayId\]\);/,
    )?.[0];
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain('sessionRef.current?.close()');
    expect(cleanup).toContain('sessionRef.current = null');
    expect(cleanup).toContain('setTerminalConnected(false)');
    expect(src).not.toMatch(/\}, \[gatewayId, status\]\);/);
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
      "{mode === 'shell' && shellReady ? (terminalConnected ? 'live' : 'starting…') : statusLabel(status)}",
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

  test('a clean stream close reaches a false-setter', () => {
    const src = readScreen();
    expect(src).toContain('onClose: () => {');
    expect(src).toContain(
      "onClose: () => {\n            setTerminalError('Terminal stream closed');\n            sessionRef.current = null;\n            setTerminalConnected(false);\n          },",
    );
  });

  test('a rejected send restores the input and only clears the flag on a 404', () => {
    const src = readScreen();
    expect(src).toContain('setInput(value);');
    expect(src).toContain('if (message.includes(\'404\'))');
    expect(src).toContain('setTerminalConnected(false);');
  });
});

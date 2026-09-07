declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readScreen(): string {
  return readSource(['src', 'app', 'gateway', 'diagnostics.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// The Run-live-check Button holds a real `running` boolean that already
// swaps the label and disables the button through the live check —
// but without a `busy` half a screen-reader user heard a flat disabled
// label while a sighted user saw the in-flight state. The fix is a
// one-line `busy={running}` wiring onto the `busy` prop Button spreads
// defined-only into accessibilityState.
describe('diagnostics live-check busy state', () => {
  test('the Run-live-check button passes busy={running}', () => {
    const src = readScreen();
    expect(src).toContain('busy={running}');
  });

  test('the busy wiring lands exactly once', () => {
    const src = readScreen();
    expect(src.match(/busy=\{running\}/g)?.length ?? 0).toBe(1);
  });

  test('the label ternary stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain("label={running ? 'Checking…' : 'Run live check'}");
  });

  test('the disabled gate stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('disabled={!healthUrl || running}');
  });

  test('the running state still wraps the live check', () => {
    const src = readScreen();
    expect(src).toContain('setRunning(true)');
    expect(src).toContain('setRunning(false)');
  });

  test('Button spreads a defined-only busy half', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

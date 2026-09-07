declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readScreen(): string {
  return readSource(['src', 'app', '(tabs)', 'activity.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// The Start-a-run Button holds a real `starting` boolean that already
// swaps the label and disables the button while the run is created —
// but without a `busy` half a screen-reader user heard a flat disabled
// label while a sighted user saw the in-flight state. The fix is a
// one-line `busy={starting}` wiring onto the `busy` prop Button spreads
// defined-only into accessibilityState.
describe('activity start busy state', () => {
  test('the Run-task button passes busy={starting}', () => {
    const src = readScreen();
    expect(src).toContain('busy={starting}');
  });

  test('the busy wiring lands exactly once', () => {
    const src = readScreen();
    expect(src.match(/busy=\{starting\}/g)?.length ?? 0).toBe(1);
  });

  test('the label ternary stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain("label={starting ? 'Starting…' : 'Run task'}");
  });

  test('the disabled gate stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain("disabled={!runPrompt.trim() || starting || status !== 'connected'}");
  });

  test('the starting state still wraps startRun', () => {
    const src = readScreen();
    expect(src).toContain('setStarting(true)');
    expect(src).toContain('setStarting(false)');
  });

  test('the run-prompt TextField stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain("editable={!starting && status === 'connected'}");
    expect(src).toContain('accessibilityLabel="Run prompt"');
  });

  test('Button spreads a defined-only busy half', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

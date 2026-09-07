declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSheet(): string {
  return readSource(['src', 'components', 'chat', 'thread-config-sheet.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// The thread-config "Show older sessions" Button holds a real in-flight
// boolean (loadingOlderSessions) that already swaps the label and disables
// the button — but without a `busy` half a screen-reader user heard the
// swapped label with no busy state. The fix is a one-line
// `busy={loadingOlderSessions}` wiring onto the `busy` prop the group-room
// busy item added to `Button`.
describe('thread-config show-older busy state', () => {
  test('the Show-older button passes busy={loadingOlderSessions}', () => {
    const src = readSheet();
    expect(src).toContain('busy={loadingOlderSessions}');
  });

  test('the busy wiring lands exactly once on the older-sessions boolean', () => {
    const src = readSheet();
    expect(src.match(/busy=\{loadingOlderSessions\}/g)?.length ?? 0).toBe(1);
  });

  test('the label ternary stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain("label={loadingOlderSessions ? 'Loading older…' : 'Show older sessions'}");
  });

  test('the disabled gate stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('disabled={loadingOlderSessions}');
  });

  test('the onShowOlder && hasMoreSessions render gate stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('{onShowOlder && hasMoreSessions ? (');
  });

  test('the session and model picker selected wirings stay untouched', () => {
    const src = readSheet();
    expect(src).toContain('accessibilityState={{ selected: isCurrent }}');
    expect(src).toContain('accessibilityState={{ selected: isCurrent, disabled: item.available === false }}');
  });

  test('Button still spreads busy only when defined', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

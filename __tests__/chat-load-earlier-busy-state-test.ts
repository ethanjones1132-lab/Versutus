declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readScreen(): string {
  return readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// The Load-earlier header Button holds the real `loadingEarlierHistory`
// boolean that already swaps the label and disables the button while the
// history page loads — but without a `busy` half a screen-reader user
// heard a flat disabled label while a sighted user saw the in-flight
// state. The fix is a one-line `busy={loadingEarlierHistory}` wiring
// onto the `busy` prop Button spreads defined-only into accessibilityState.
describe('chat load-earlier busy state', () => {
  test('the Load-earlier button passes busy={loadingEarlierHistory}', () => {
    const src = readScreen();
    expect(src).toContain('busy={loadingEarlierHistory}');
  });

  test('the busy wiring lands exactly once', () => {
    const src = readScreen();
    expect(src.match(/busy=\{loadingEarlierHistory\}/g)?.length ?? 0).toBe(1);
  });

  test('the label ternary stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain("label={loadingEarlierHistory ? 'Loading…' : 'Load earlier messages'}");
  });

  test('the disabled gate stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('disabled={loadingEarlierHistory}');
  });

  test('the render gate stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('hasMoreHistory && messages.length > 0 ? (');
  });

  test('the loadEarlierMessages handler stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('onPress={() => void loadEarlierMessages()}');
  });

  test('the ChatSkeleton empty-state branch stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('<ChatSkeleton />');
  });

  test('Button spreads a defined-only busy half', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

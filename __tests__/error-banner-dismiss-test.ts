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

describe('error banner is dismissible and collapsible', () => {
  test('the dismiss-kind branch no longer renders a card with no control at all', () => {
    // Reported from device use: an error filled the screen with four stacked
    // rows and could not be closed. `case 'dismiss'` set onRetry undefined AND
    // retryLabel undefined, so ErrorCard rendered no button whatsoever, and
    // nothing in the component ever cleared lastError.
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    // Scoped to the element, not the file: a sibling card elsewhere taking a
    // prop by the same name must not be able to satisfy this.
    const card = src.match(/<ErrorCard[\s\S]*?\/>/)?.[0];
    expect(card).toBeDefined();
    expect(card).toContain('onDismiss={onDismiss}');
    expect(card).toContain('collapsible');
  });

  test('only an error with nothing to act on clears itself on a timer', () => {
    // A setup or reconnect banner carries the control that fixes the fault;
    // timing that out would take the fix away while the operator is reading.
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(src).toContain('DISMISSIBLE_ERROR_TIMEOUT_MS');
    const effect = src.match(/const selfClearing = [\s\S]*?\n  \}, \[selfClearing, onDismiss\]\);/)?.[0];
    expect(effect).toBeDefined();
    expect(effect).toContain("button.kind === 'dismiss'");
    expect(effect).toContain('if (!selfClearing) return undefined;');
    expect(effect).toContain('clearTimeout(timer)');
  });

  test('the banner clears through the context, not local state', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('onDismiss={clearLastError}');
    const provider = readSource('src', 'context', 'gateway-provider.tsx');
    expect(provider).toContain('clearLastError: () => void;');
    expect(provider).toContain('const clearLastError = useCallback(() => setLastError(null), []);');
  });

  test('ErrorCard hides Affected and Next behind a toggle when collapsible', () => {
    const src = readSource('src', 'components', 'ui', 'ErrorCard.tsx');
    // Cause always shows: an error the operator cannot read is worse than a tall one.
    expect(src).toContain('Cause: {cause}');
    expect(src).toContain('{showDetail && affected ?');
    expect(src).toContain('{showDetail && next ?');
    expect(src).toContain('const showDetail = !collapsible || !hasDetail || expanded;');
  });

  test('the toggle announces its expanded state and only shows when there is detail', () => {
    const src = readSource('src', 'components', 'ui', 'ErrorCard.tsx');
    expect(src).toContain('const hasDetail = Boolean(affected || next);');
    expect(src).toContain('{collapsible && hasDetail ?');
    expect(src).toContain('expanded={expanded}');
  });

  test('a non-collapsible ErrorCard still shows every row, so other callers do not change', () => {
    // collapsible defaults to false; every existing ErrorCard caller keeps
    // rendering cause, affected and next exactly as before.
    const src = readSource('src', 'components', 'ui', 'ErrorCard.tsx');
    expect(src).toContain('collapsible = false');
  });
});

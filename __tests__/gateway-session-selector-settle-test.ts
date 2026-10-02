// SESS-1: opening the thread sheet with no client must not leave it reading
// "The gateway is answering." forever. The provider now settles an unreadable
// list as refused — both on the no-client open and when the selector is reset
// while the sheet is already open.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function provider(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function openSessionSelector(): string {
  const src = provider();
  const start = src.indexOf('const openSessionSelector = useCallback');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('const loadOlderSessions = useCallback', start));
}

describe('SESS-1: no client settles the session list instead of spinning', () => {
  test('the no-client path settles an unreadable list as refused', () => {
    const body = openSessionSelector();
    expect(body).toContain('settleUnreadableList');
    // The settle produces the failed, unloaded state — what `sessionListCopy`
    // names and what the sheet renders as an error rather than a spinner.
    expect(body).toMatch(
      /setSessionListState\(\(previous\) =>\s*previous\.loaded \|\| previous\.failed \? previous : \{ sessions: \[\], loaded: false, failed: true \}/,
    );
    expect(body).toMatch(/if \(!client\) \{[\s\S]*?settleUnreadableList\(\);[\s\S]*?return;/);
  });

  test('a cache miss with no client settles; with a client the network read owns it', () => {
    const body = openSessionSelector();
    expect(body).toMatch(/if \(!cached\) \{[\s\S]*?if \(!client\) settleUnreadableList\(\);/);
    // The catch arm only settles on the no-client path too.
    expect(body).toMatch(/\.catch\(\(\) => \{\s*if \(!client\) settleUnreadableList\(\);/);
  });

  test('resetSessionSelector settles the list as a refused first read', () => {
    const src = provider();
    const reset = src.slice(
      src.indexOf('const resetSessionSelector = useCallback'),
      src.indexOf('const [currentSessionId', src.indexOf('const resetSessionSelector = useCallback')),
    );
    // An already-open sheet used to keep emptySessionList() — the spinner
    // state. The refused-first-read fold is the copy the sheet already has.
    expect(reset).toContain(
      'setSessionListState(applySessionListRead(emptySessionList<HermesSession>(), { ok: false }));',
    );
    expect(reset).not.toContain(
      'setSessionListState(emptySessionList<HermesSession>());',
    );
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatRosterSource(): string {
  // chat-roster.tsx is CRLF on disk; normalize so the block regexes below do
  // not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-roster.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('roster load failure', () => {
  test('the load-failed empty state offers a Retry action wired to the refresh handler', () => {
    // A failed first read leaves the operator with a named reason and no way
    // forward except discovering pull-to-refresh. The empty state now carries
    // the same gesture as a visible Retry button.
    const src = readChatRosterSource();
    const failed = src.match(/emptyView\.kind === 'load-failed'[\s\S]*?\) : null/)?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/title="Couldn't load agents"/);
    expect(failed).toMatch(/actionLabel="Retry"/);
    expect(failed).toMatch(/onAction=\{handleRefresh\}/);
  });

  test('the retry is offered only when there is something to re-read', () => {
    // handleRefresh is undefined when onRefresh is absent (gateway not
    // connected), and EmptyState renders no button without onAction — so
    // passing handleRefresh through is exactly "wired to onRefresh when
    // present" with no extra conditional.
    const src = readChatRosterSource();
    expect(src).toMatch(/const handleRefresh = onRefresh\n {4}\? \(\) => \{/);
    expect(src).toMatch(/: undefined;/);
  });

  test('the no-match empty state keeps its Clear search action', () => {
    const src = readChatRosterSource();
    const noMatch = src.match(/emptyView\.kind === 'no-match'[\s\S]*?\) : null/)?.[0];
    expect(noMatch).toBeDefined();
    expect(noMatch).toMatch(/actionLabel="Clear search"/);
    expect(noMatch).toMatch(/onAction=\{\(\) => setQuery\(''\)\}/);
  });

  test('a rooms blip still renders separately and never triggers the agents empty state', () => {
    // The rooms inventory is independent of the agent inventory: a rooms
    // failure must not look like agents failed.
    const src = readChatRosterSource();
    expect(src).toMatch(/\{groupsError \? \(/);
    const emptyViewCall = src.match(/rosterEmptyView\(\{[\s\S]*?\}\);/)?.[0];
    expect(emptyViewCall).toBeDefined();
    expect(emptyViewCall).not.toMatch(/groupsError/);
  });

  test('pull-to-refresh still offers the same gesture on the list itself', () => {
    const src = readChatRosterSource();
    expect(src).toMatch(/refreshControl=\{/);
    expect(src).toMatch(/onRefresh=\{handleRefresh\}/);
  });
});

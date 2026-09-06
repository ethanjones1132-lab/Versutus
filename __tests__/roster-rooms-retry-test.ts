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

describe('roster rooms retry', () => {
  test('a rooms-only failure offers a Retry action wired to the refresh handler', () => {
    // A rooms-only failure (agents fine, rooms failed) left the operator with
    // a bare caption and pull-to-refresh as the only recourse. The header now
    // carries the same re-read gesture as a visible Retry button.
    const src = readChatRosterSource();
    const groupsBlock = src.match(/\{groupsError \? \([\s\S]*?\) : null\}/)?.[0];
    expect(groupsBlock).toBeDefined();
    expect(groupsBlock).toMatch(/{groupsError}/);
    const retryBlock = src.match(/\{groupsError && handleRefresh \? \([\s\S]*?\) : null\}/)?.[0];
    expect(retryBlock).toBeDefined();
    expect(retryBlock).toMatch(/label="Retry"/);
    expect(retryBlock).toMatch(/onPress=\{handleRefresh\}/);
  });

  test('the rooms Retry is offered only when there is something to re-read', () => {
    // handleRefresh is undefined when onRefresh is absent (gateway not
    // connected), so gating on it is exactly "wired to onRefresh when
    // present" with no extra conditional — and no Retry renders without a
    // caption to retry.
    const src = readChatRosterSource();
    expect(src).toMatch(/\{groupsError && handleRefresh \? \(/);
  });

  test('the groupsError caption copy is unchanged', () => {
    const src = readChatRosterSource();
    const groupsBlock = src.match(/\{groupsError \? \([\s\S]*?\) : null\}/)?.[0];
    expect(groupsBlock).toBeDefined();
    expect(groupsBlock).toMatch(/variant="caption"/);
    expect(groupsBlock).toMatch(/style=\{styles\.error\}/);
    expect(groupsBlock).toMatch(/{groupsError}/);
  });

  test('the agents load-failed Retry is byte-identical', () => {
    const src = readChatRosterSource();
    const failed = src.match(/emptyView\.kind === 'load-failed'[\s\S]*?\) : null/)?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/title="Couldn't load agents"/);
    expect(failed).toMatch(/actionLabel="Retry"/);
    expect(failed).toMatch(/onAction=\{handleRefresh\}/);
  });

  test('a rooms blip still never triggers the agents empty state', () => {
    const src = readChatRosterSource();
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

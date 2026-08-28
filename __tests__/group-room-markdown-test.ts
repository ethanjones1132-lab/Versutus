declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGroupRoomViewSource(): string {
  // group-room-view.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('group room markdown', () => {
  function renderItemBranches(): { user: string; bot: string } {
    const src = readGroupRoomViewSource();
    const start = src.indexOf('renderItem={({ item }) =>');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n        }\n      />', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const split = body.indexOf('\n          ) : (');
    expect(split).toBeGreaterThan(-1);
    return { user: body.slice(0, split), bot: body.slice(split) };
  }

  test('MarkdownText is imported from the chat markdown renderer', () => {
    const src = readGroupRoomViewSource();
    expect(src).toMatch(
      /import \{ MarkdownText \} from '@\/components\/chat\/markdown\/markdown-text';/,
    );
  });

  test('the bot reply branch renders MarkdownText so soul-driven markdown shows formatted', () => {
    const { bot } = renderItemBranches();
    expect(bot).toMatch(/<MarkdownText text=\{item\.text\}\s*\/>/);
    // The raw-text renderer is gone from the bot bubble; the byline stays a Text.
    expect(bot).not.toMatch(/<Text variant="body" color="primary">/);
    expect(bot).toMatch(/botByline/);
  });

  test('the user branch keeps its plain Text — operator input is not parsed', () => {
    const { user } = renderItemBranches();
    expect(user).toMatch(/<Text variant="body" color="primary">\{item\.text\}<\/Text>/);
    expect(user).not.toMatch(/MarkdownText/);
  });
});
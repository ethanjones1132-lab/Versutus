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

describe('roster render cost', () => {
  test('ChatRoster is exported via React.memo so unchanged props skip a re-render', () => {
    // The Chat tab landing re-renders on every provider change (streamed
    // frames, run events, connection pulses). Wrapping the export in memo
    // lets a parent that passes stable props skip remounting the whole list.
    const src = readChatRosterSource();
    expect(src).toMatch(/export const ChatRoster = memo\(ChatRosterImpl\)/);
    expect(src).toMatch(/ChatRoster\.displayName = 'ChatRoster'/);
  });

  test('the roster rows render through a windowed FlatList instead of a plain map', () => {
    // The Chat landing — the first screen the operator sees — was the last
    // large list without windowing. A 200-bot roster must mount only the rows
    // on screen, not the whole ScrollView at once per streamed frame.
    const src = readChatRosterSource();
    const list = src.match(/\n {4}<FlatList<RosterItem>[\s\S]*?\n {4}\/>/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/data=\{items\}/);
    expect(list).toMatch(/keyExtractor=\{\(item\) => item\.key\}/);
    expect(list).toMatch(/removeClippedSubviews/);
    expect(list).toMatch(/initialNumToRender=\{12\}/);
    expect(list).toMatch(/maxToRenderPerBatch=\{16\}/);
    expect(list).toMatch(/windowSize=\{9\}/);
  });

  test('the search TextField lives inside ListHeaderComponent, not the windowed rows', () => {
    // The search field is fixed chrome — it must not become a virtualized row
    // that unmounts as the operator scrolls. The group-room conversion keeps
    // the same split: fixed bits above/below, only the rows window.
    const src = readChatRosterSource();
    const list = src.match(/\n {4}<FlatList<RosterItem>[\s\S]*?\n {4}\/>/)?.[0];
    expect(list).toBeDefined();
    // Header carries the search input, the agent error, and the rooms error.
    expect(list).toMatch(/ListHeaderComponent=\{[\s\S]*?placeholder="Search agents"/);
    expect(list).toMatch(/ListHeaderComponent=\{[\s\S]*?styles\.error/);
    // Footer carries the New Agent / New Group Room rows + capability notes.
    expect(list).toMatch(/ListFooterComponent=\{[\s\S]*?title="New Agent"/);
    expect(list).toMatch(/ListFooterComponent=\{[\s\S]*?title="New Group Room"/);
    // The old unbounded JSX map into the ScrollView is gone — rows are now
    // built into the windowed `items` array (visibleRows.map(...) returns
    // RosterItem objects, not <ListRow>), and renderItem is the only place
    // that returns rows.
    expect(src).not.toMatch(/visibleRows\.map\(\(row\) => \{/);
    expect(src).not.toMatch(/visibleGroups\.map\(\(group\) => \(/);
    // Only the windowed renderItem returns a ListRow for a row/group.
    expect(src).toMatch(/const renderItem = \(\{ item \}: \{ item: RosterItem \}\) =>/);
  });
});

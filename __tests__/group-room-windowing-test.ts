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

describe('group room transcript windowing', () => {
  test('entries render through a windowed FlatList instead of a plain map', () => {
    // The room transcript grows across days of rounds; a plain map inside a
    // ScrollView mounts every bubble and re-renders it all on each reply
    // batch. The chat thread bounds the same class via windowing props.
    const src = readGroupRoomViewSource();
    // Anchor on the JSX opening tag (a newline + 6 spaces precedes it; the
    // useRef<FlatList<RoomEntry>> type declaration does not qualify) and
    // run to the list's own closing `/>` at the same indent.
    const list = src.match(/\n      <FlatList[\s\S]*?\n      \/>/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/data=\{entries\}/);
    expect(list).toMatch(/keyExtractor=\{\(entry\) => entry\.id\}/);
    expect(list).toMatch(/removeClippedSubviews/);
    expect(list).toMatch(/initialNumToRender=\{\d+\}/);
    expect(list).toMatch(/maxToRenderPerBatch=\{\d+\}/);
    expect(list).toMatch(/windowSize=\{\d+\}/);
    // The iter-079 pin guard stays wired on the windowed list.
    expect(list).toMatch(/onScroll=\{handleScroll\}/);
    expect(list).toMatch(/scrollEventThrottle=\{16\}/);
    // The old unbounded map is gone.
    expect(src).not.toMatch(/entries\.map/);
  });

  test('the room card, error hint and empty hint live in ListHeaderComponent', () => {
    // The room card (plan line, rename/disband pills, member chips) and the
    // history/empty hints are not per-round rows — they render once as the
    // list header while only the exchange rows virtualize.
    const src = readGroupRoomViewSource();
    const list = src.match(/\n      <FlatList[\s\S]*?\n      \/>/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/ListHeaderComponent=\{\s*<View style=\{styles\.listHeader\}/);
    // ListHeaderComponent and renderItem each appear once in the file, so
    // the header slice can be taken straight from the source.
    const header = src.match(/ListHeaderComponent=\{[\s\S]*?renderItem/)?.[0];
    expect(header).toBeDefined();
    expect(header).toContain('styles.roomCard');
    expect(header).toContain('Could not load earlier replies from the Gate');
    expect(header).toContain('Say something to the room');
  });
});
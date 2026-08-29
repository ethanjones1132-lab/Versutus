declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readActivitySource(): string {
  // The file is CRLF on disk; normalize so the lookups below are line-ending
  // independent.
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'app', '(tabs)', 'activity.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('activity run list windowing', () => {
  const src = readActivitySource();

  test('the finished-runs block renders through a windowed FlatList, not a bare map in a ScrollView', () => {
    // The whole tab is one windowed FlatList now...
    expect(src).toContain("import { FlatList");
    expect(src).toContain('<FlatList');

    // ...and the finished runs are no longer materialised by a bare .map of
    // <RunCard> inside the old ScrollView — they are data rows fed to the list.
    expect(src).not.toMatch(/finishedRuns\.map\(/);
    expect(src).not.toMatch(/ScrollView[\s\S]{0,400}finishedRuns\.map/);

    // RunCard still renders, but via the list's renderItem, not a .map literal.
    expect(src).toContain('RunCard');
    expect(src).toContain('renderItem=');
  });

  test('the FlatList carries the chat-thread windowing props', () => {
    // Mirror the chat thread's windowing (chat-screen.tsx:1229-1232).
    expect(src).toContain('removeClippedSubviews');
    expect(src).toMatch(/initialNumToRender=\{\s*12\s*\}/);
    expect(src).toMatch(/maxToRenderPerBatch=\{\s*16\s*\}/);
    expect(src).toMatch(/windowSize=\{\s*9\s*\}/);
  });

  test('the fixed sections stay outside the scrolling row data as header/footer', () => {
    // Start card, cron section and agent targets must not become list rows.
    expect(src).toContain('ListHeaderComponent=');
    expect(src).toContain('ListFooterComponent=');
    expect(src).toContain('<CronSection cronReloadSignal={cronReloadSignal} />');
    expect(src).toContain('startCard');
    // The approval decision card renders in the header, not as a data row.
    expect(src).toContain('ApprovalDecisionCard');
  });
});

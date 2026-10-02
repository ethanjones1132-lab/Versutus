declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  // agentic-run-sheet.tsx is CRLF on disk; normalize so the block regexes below
  // do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'agentic-run-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// A finished agentic run replays from the Gate's per-run SSE file, capped at
// 8 MiB (backend-run-streams.mjs DEFAULT_MAX_BYTES_PER_RUN) — tens of thousands
// of frames on a long run. Mapping every frame into one View of <Text> nodes
// inside a plain ScrollView built and mounted the whole transcript in a single
// pass, which froze the JS thread for seconds on a mid-range phone. The rest of
// the app already bounds this class of list (runs.tsx, chat-screen.tsx,
// group-room-view.tsx, json-view.tsx) with a windowed FlatList; the transcript
// sheet did not.
describe('agentic-run transcript windowing', () => {
  test('events render through a windowed FlatList, not a bare map in a ScrollView', () => {
    const src = readSheetSource();
    expect(src).toMatch(/import \{ FlatList,/);
    // The sheet body is the list itself, so it owns the scroll.
    expect(src).not.toMatch(/<ScrollView/);

    // The list block runs to its own closing `/>` at the same indent.
    const list = src.match(/\n      <FlatList[\s\S]*?\n      \/>/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/data=\{events \?\? \[\]\}/);
    expect(list).toMatch(/renderItem=\{renderEvent\}/);
    // Index keys, as the map it replaced used.
    expect(list).toMatch(/keyExtractor=\{\(_event, index\) => String\(index\)\}/);
    expect(list).toMatch(/removeClippedSubviews/);
    expect(list).toMatch(/initialNumToRender=\{12\}/);
    expect(list).toMatch(/maxToRenderPerBatch=\{16\}/);
    expect(list).toMatch(/windowSize=\{9\}/);
    // A list inside BaseSheet with no maxHeight grows to its content and
    // mounts every row. The other BaseSheet lists pin maxHeight the same way.
    expect(list).toMatch(/style=\{\[styles\.list, \{ maxHeight: listMaxHeight \}\]\}/);
    expect(src).toContain('transcriptListMaxHeight');
    expect(src).toContain('flexGrow: 0');

    // The old unbounded map is gone.
    expect(src).not.toMatch(/events\.map\(/);
    expect(src).not.toMatch(/\{events && events\.length > 0 \?/);
  });

  test('the fixed top half and the empty replay stay out of the row data', () => {
    // The run id, divider, verdict, retry and loading pair are not events: they
    // render once in the header while only the event lines virtualise. The
    // "replay completed without events" copy is the empty state, so it must not
    // be confused with the loading branch it shares the `events === null` test
    // with.
    const src = readSheetSource();
    const list = src.match(/\n      <FlatList[\s\S]*?\n      \/>/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/ListHeaderComponent=\{/);
    expect(list).toMatch(/ListEmptyComponent=\{/);

    const header = src.match(/ListHeaderComponent=\{[\s\S]*?\n        \}/)?.[0];
    expect(header).toBeDefined();
    expect(header).toMatch(/\{runId\}<\/Text>/);
    expect(header).toMatch(/<Divider \/>/);
    expect(header).toMatch(/formatRunFailure\(error\) \?\? error/);
    expect(header).toMatch(/label="Retry"/);
    expect(header).toMatch(/Skeleton width="90%" height=\{44\}/);
    expect(header).toMatch(/Loading…/);

    const empty = src.match(/ListEmptyComponent=\{[\s\S]*?events !== null && !error[\s\S]*?\n        \}/)?.[0];
    expect(empty).toBeDefined();
    expect(empty).toMatch(/The replay completed without events\./);

    // The gap the body container used to carry now belongs to the header cell,
    // and the row separator keeps the one the events container had, so the sheet
    // reads with the same spacing it always had.
    expect(src).toMatch(/ItemSeparatorComponent=\{\(\) => <View style=\{styles\.eventGap\} \/>\}/);
    expect(src).toMatch(/eventGap: \{ height: Spacing\.one \}/);
  });
});
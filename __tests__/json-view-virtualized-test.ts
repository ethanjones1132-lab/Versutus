import { flattenJsonTreeRows, jsonTreeNode } from '@/lib/terminal/json-tree';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(relative: string): string {
  // The touched .tsx/.ts sources are CRLF on disk (mixed at times); normalize
  // so the block regexes below do not depend on the file's line endings.
  return nodeFs
    .readFileSync([__dirname, '..', 'src', ...relative.split('/')].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('flattenJsonTreeRows', () => {
  const rootOf = (value: unknown) => jsonTreeNode(value);

  test('a collapsed tree renders only the root container row', () => {
    const rows = flattenJsonTreeRows(rootOf({ a: { x: 1 } }), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'container',
      path: 'root',
      isRoot: true,
      open: false,
      chevron: '▸',
    });
  });

  test('expanding the root reveals braces, keys and child rows in order', () => {
    const rows = flattenJsonTreeRows(rootOf({ a: { x: 1 } }), new Set(['root']));
    expect(rows.map((row) => row.id)).toEqual([
      'c:root',
      '{:root',
      'k:root.a',
      'c:root.a',
      '}:root',
    ]);
    expect(rows[0]).toMatchObject({ open: true, chevron: '▾', preview: '1 key' });
    // Keys and braces sit at the container's own depth: they render inside
    // the container's indent block, a fixed offset deeper.
    expect(rows[2]).toMatchObject({ kind: 'key', key: 'a', depth: 0 });
    expect(rows[3]).toMatchObject({ kind: 'container', path: 'root.a', depth: 1, open: false });
  });

  test('a collapsed container prunes its whole subtree', () => {
    const rows = flattenJsonTreeRows(rootOf({ a: { x: 1, y: 2 } }), new Set(['root']));
    expect(rows.some((row) => row.path === 'root.a.x')).toBe(false);
    expect(rows.some((row) => row.path === 'root.a.y')).toBe(false);
  });

  test('expanding a mid-level path adds exactly that subtree', () => {
    const rows = flattenJsonTreeRows(rootOf({ a: { x: 1 } }), new Set(['root', 'root.a']));
    expect(rows.map((row) => row.id)).toEqual([
      'c:root',
      '{:root',
      'k:root.a',
      'c:root.a',
      '{:root.a',
      'k:root.a.x',
      'p:root.a.x',
      '}:root.a',
      '}:root',
    ]);
    const x = rows[6];
    expect(x).toMatchObject({ kind: 'primitive', path: 'root.a.x', value: '1', primitive: 'number' });
  });

  test('array containers render bracket rows and index paths', () => {
    const rows = flattenJsonTreeRows(rootOf([1, 2]), new Set(['root']));
    expect(rows.map((row) => row.id)).toEqual([
      'c:root',
      '[:root',
      'p:root[0]',
      'p:root[1]',
      ']:root',
    ]);
    expect(rows[0]).toMatchObject({ chevron: '−', preview: '2 items' });
    expect(rows[3]).toMatchObject({ kind: 'primitive', path: 'root[1]', value: '2' });
  });

  test('a closed array container shows the plus chevron', () => {
    const rows = flattenJsonTreeRows(rootOf([1]), new Set());
    expect(rows[0]).toMatchObject({ chevron: '+' });
  });

  test('an empty container keeps both braces with nothing between', () => {
    const rows = flattenJsonTreeRows(rootOf({}), new Set(['root']));
    expect(rows.map((row) => row.id)).toEqual(['c:root', '{:root', '}:root']);
  });

  test('rows carry the visual nesting depth the indent derives from', () => {
    const rows = flattenJsonTreeRows(rootOf({ a: { x: 1 } }), new Set(['root', 'root.a']));
    // Root container lives at depth 0; its braces and keys render inside its
    // indent block (same depth), and each child row adds one level.
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ['c:root', 0],
      ['{:root', 0],
      ['k:root.a', 0],
      ['c:root.a', 1],
      ['{:root.a', 1],
      ['k:root.a.x', 1],
      ['p:root.a.x', 2],
      ['}:root.a', 1],
      ['}:root', 0],
    ]);
  });
});

describe('JsonView windowed tree', () => {
  const src = () => readSource('components/terminal/json-view.tsx');

  test('rows render through a FlatList with windowing props, derived from the expanded set', () => {
    const source = src();
    expect(source).toMatch(/const rows = useMemo\(\(\) => flattenJsonTreeRows\(root, expanded\), \[root, expanded\]\)/);
    // The block runs to the FlatList's own closing tag (6-space indent); the
    // row view's self-closing `/>` lives deeper inside renderItem.
    const list = source.match(/<FlatList[\s\S]*?\n      \/>/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/data=\{rows\}/);
    expect(list).toMatch(/keyExtractor=\{\(row\) => row\.id\}/);
    expect(list).toMatch(/removeClippedSubviews/);
    expect(list).toMatch(/initialNumToRender=\{12\}/);
    expect(list).toMatch(/maxToRenderPerBatch=\{16\}/);
    expect(list).toMatch(/windowSize=\{9\}/);
    // A pressable tree inside a scroll host: taps land on the first press and
    // the nested list does not fight the outer scroll on Android.
    expect(list).toMatch(/keyboardShouldPersistTaps="handled"/);
    expect(list).toMatch(/nestedScrollEnabled/);
  });

  test('expand/collapse stays per path via the expanded set', () => {
    const source = src();
    expect(source).toMatch(/setExpanded\(\(current\) => \{/);
    expect(source).toMatch(/next\.delete\(path\)/);
    expect(source).toMatch(/next\.add\(path\)/);
    expect(source).toMatch(/const next = new Set\(current\)/);
  });

  test('the recursive NodeRow renderer is gone', () => {
    const source = src();
    expect(source).not.toMatch(/NodeRow/);
    expect(source).not.toMatch(/entries\.map/);
    expect(source).not.toMatch(/children\.map/);
  });

  test('the tree root shrinks so the list is bounded by its host', () => {
    const source = src();
    expect(source).toMatch(/root: \{\s*\n\s*width: '100%',\n\s*flexShrink: 1,/);
  });

  test('indent derives from the row depth using the spacing tokens', () => {
    // The flat row model carries depth, not pixels — the renderer derives
    // each row's paddingLeft from Spacing so the json-tree lib stays pure
    // (importing @/constants/tokens pulls reanimated into jest).
    const source = src();
    expect(source).toMatch(/Spacing\.one \* depth \+ \(Spacing\.three \* depth \* \(depth \+ 1\)\) \/ 2/);
    expect(source).toMatch(/Spacing\.four/);
    expect(source).toMatch(/Spacing\.three/);
  });
});

describe('CommandResultView tree host', () => {
  test('the json wrapper shrinks so the list is bounded by the sheet', () => {
    const source = readSource('components/terminal/command-result-view.tsx');
    expect(source).toMatch(/json: \{\s*\n\s*gap: Spacing\.two,\n\s*flexShrink: 1,/);
  });
});

describe('CommandLogSheet hosts', () => {
  test('text results keep the ScrollView while JSON hands scrolling to the tree list', () => {
    const source = readSource('components/terminal/command-log-sheet.tsx');
    expect(source).toContain('describeCommandResult');
    // Exactly one ScrollView remains — the text branch's. The JSON branch
    // renders the result directly so JsonView's FlatList owns the scroll.
    expect(source.match(/<ScrollView/g)?.length ?? 0).toBe(1);
    expect(source).toMatch(/model\.kind === 'text' \? \(/);
    expect(source.match(/<CommandResultView log=\{log\} \/>/g)?.length ?? 0).toBe(2);
  });
});

describe('terminal RPC pane host', () => {
  test('the RPC pane hosts the result card in a list so the tree is never nested in a plain ScrollView', () => {
    const source = readSource('components/terminal/terminal-screen.tsx');
    // The pane used to be a plain ScrollView; a windowed tree inside it would
    // warn and render every node. It is now a FlatList: panel in the header,
    // result card as the item, hint as the empty state.
    expect(source).toMatch(/<FlatList\n          style=\{styles\.commandContent\}/);
    expect(source).not.toMatch(/<ScrollView\n          style=\{styles\.commandContent\}/);
    expect(source).toMatch(/data=\{commandLog \? \[commandLog\] : \[\]\}/);
    expect(source).toMatch(/keyExtractor=\{\(\) => 'result'\}/);
    expect(source).toMatch(/ListHeaderComponent=\{/);
    expect(source).toMatch(/ListHeaderComponent=\{[\s\S]*?<GatewayCommandPanel/);
    expect(source).toMatch(/ListEmptyComponent=\{[\s\S]*?Run a command to inspect/);
    expect(source).toMatch(/onOpenOutput=\{\(\) => setLogSheetVisible\(true\)\}/);
    expect(source).toMatch(/import \{ FlatList,/);
  });
});
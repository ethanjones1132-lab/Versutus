import { createElement } from 'react';
import { FlatList } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { JsonView } from '@/components/terminal/json-view';
import {
  collectJsonTreeContainerPaths,
  flattenJsonTreeRows,
  jsonTreeNode,
  type JsonTreeRow,
} from '@/lib/terminal/json-tree';

// JsonView imports the token palette (which pulls reanimated), the haptics
// wrapper, expo-clipboard, and the UI Text primitive. These tests exercise
// row/expansion behaviour, so the native edges are stubbed as in the other
// terminal component tests.
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));
jest.mock('@/lib/haptics', () => ({
  haptics: { light: jest.fn(), success: jest.fn() },
}));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#0af',
    accentWarm: '#fa0',
    textPrimary: '#fff',
    textSecondary: '#ccc',
    textTertiary: '#999',
  }),
}));
jest.mock('@/components/ui', () => ({ Text: 'Text' }));

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

describe('json tree path encoding', () => {
  function uniqueIds(rows: JsonTreeRow[]): string[] {
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(rows.length);
    return ids;
  }

  test('a literal dotted key does not alias a nested object path', () => {
    const root = jsonTreeNode({ 'a.b': { x: 1 }, a: { b: { y: 2 } } });
    const expanded = new Set(['root', 'root["a.b"]', 'root.a']);
    const rows = flattenJsonTreeRows(root, expanded);
    uniqueIds(rows);

    expect(rows).toContainEqual(
      expect.objectContaining({ kind: 'key', key: 'a.b', path: 'root["a.b"]' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ kind: 'primitive', path: 'root["a.b"].x', value: '1' }),
    );
    // The nested a -> b container has its own plain path and stays collapsed.
    expect(rows).toContainEqual(
      expect.objectContaining({ kind: 'container', path: 'root.a.b', open: false }),
    );
    expect(rows.some((row) => row.path === 'root.a.b.y')).toBe(false);
  });

  test('a bracket-looking literal key does not alias an array index path', () => {
    const root = jsonTreeNode({ 'a[0]': 'literal', a: ['nested'] });
    const rows = flattenJsonTreeRows(root, new Set(['root', 'root.a']));
    uniqueIds(rows);

    expect(rows).toContainEqual(
      expect.objectContaining({ kind: 'primitive', path: 'root["a[0]"]', value: '"literal"' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ kind: 'primitive', path: 'root.a[0]', value: '"nested"' }),
    );
  });

  test('empty keys and keys with quotes or backslashes use quoted bracket segments', () => {
    const root = jsonTreeNode({ '': 'empty', 'a"b': 'quote', 'a\\b': 'slash', 'a.b': 'dot' });
    const rows = flattenJsonTreeRows(root, new Set(['root']));
    uniqueIds(rows);

    expect(
      rows
        .filter((row): row is Extract<JsonTreeRow, { kind: 'primitive' }> => row.kind === 'primitive')
        .map((row) => [row.path, row.value]),
    ).toEqual([
      ['root[""]', '"empty"'],
      ['root["a\\"b"]', '"quote"'],
      ['root["a\\\\b"]', '"slash"'],
      ['root["a.b"]', '"dot"'],
    ]);
  });

  test('unsafe key segments compose at any depth without re-spelling the parent', () => {
    const root = jsonTreeNode({ 'a.b': { 'c.d': { '': 'deep' } } });
    const rows = flattenJsonTreeRows(
      root,
      new Set(['root', 'root["a.b"]', 'root["a.b"]["c.d"]']),
    );
    uniqueIds(rows);

    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: 'primitive',
        path: 'root["a.b"]["c.d"][""]',
        value: '"deep"',
      }),
    );
  });

  test('expansion opens only the container whose encoded path it names', () => {
    const root = jsonTreeNode({ a: { deep: 1 }, b: { deep: 2 } });
    const viaA = flattenJsonTreeRows(root, new Set(['root', 'root.a']));
    const viaB = flattenJsonTreeRows(root, new Set(['root', 'root.b']));

    expect(viaA.some((row) => row.path === 'root.a.deep')).toBe(true);
    expect(viaA.some((row) => row.path === 'root.b.deep')).toBe(false);
    expect(viaA.find((row) => row.kind === 'container' && row.path === 'root.b')).toMatchObject({
      open: false,
    });
    expect(viaB.some((row) => row.path === 'root.b.deep')).toBe(true);
    expect(viaB.some((row) => row.path === 'root.a.deep')).toBe(false);
    expect(viaB.find((row) => row.kind === 'container' && row.path === 'root.a')).toMatchObject({
      open: false,
    });
  });

  test('the initial expansion set names exactly the containers flattening opens', () => {
    const root = jsonTreeNode({ 'a.b': { leaf: 1 }, a: { b: { leaf: 2 } } });
    const expanded = collectJsonTreeContainerPaths(root, 2);
    expect(expanded).toEqual(new Set(['root', 'root["a.b"]', 'root.a']));

    const rows = flattenJsonTreeRows(root, expanded);
    uniqueIds(rows);
    expect(
      rows.filter((row) => row.kind === 'container' && row.open).map((row) => row.path),
    ).toEqual(['root', 'root["a.b"]', 'root.a']);
    // maxDepth stops before the nested a -> b container, so it stays closed
    // even though a plain-path encoding would have aliased it open.
    expect(rows.find((row) => row.kind === 'container' && row.path === 'root.a.b')).toMatchObject({
      open: false,
    });
    expect(rows.some((row) => row.path === 'root.a.b.leaf')).toBe(false);
  });

  test('repeated flattening of the same tree yields identical rows and ids', () => {
    const root = jsonTreeNode({ 'a.b': { x: 1 }, a: { b: { y: 2 } } });
    const expanded = collectJsonTreeContainerPaths(root, 3);
    const first = flattenJsonTreeRows(root, expanded);
    const second = flattenJsonTreeRows(root, new Set(expanded));

    expect(second).toEqual(first);
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    uniqueIds(first);
  });
});

describe('JsonView initial expansion', () => {
  async function mountJsonView(value: unknown, maxDepth = 2): Promise<ReactTestRenderer> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(JsonView, { value, maxDepth }));
    });
    return renderer;
  }

  function renderedRows(renderer: ReactTestRenderer): JsonTreeRow[] {
    return renderer.root.findByType(FlatList).props.data as JsonTreeRow[];
  }

  async function unmount(renderer: ReactTestRenderer): Promise<void> {
    await act(async () => {
      renderer.unmount();
    });
  }

  test('initial expansion opens the literal dotted-key container without the nested namesake', async () => {
    const value = { 'a.b': { leaf: 1 }, a: { b: { leaf: 2 } } };
    const renderer = await mountJsonView(value);
    try {
      const rows = renderedRows(renderer);
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size).toBe(rows.length);

      expect(
        rows.find((row) => row.kind === 'container' && row.path === 'root["a.b"]'),
      ).toMatchObject({ open: true });
      expect(
        rows.find((row) => row.kind === 'container' && row.path === 'root.a.b'),
      ).toMatchObject({ open: false });
      expect(
        rows.find((row) => row.kind === 'primitive' && row.path === 'root["a.b"].leaf'),
      ).toMatchObject({ value: '1' });
      expect(rows.some((row) => row.path === 'root.a.b.leaf')).toBe(false);
    } finally {
      await unmount(renderer);
    }
  });

  test('re-rendering with the same value keeps the same row ids', async () => {
    const value = { 'a.b': { x: 1 }, a: { b: { y: 2 } } };
    const renderer = await mountJsonView(value);
    try {
      const first = renderedRows(renderer).map((row) => row.id);
      await act(async () => {
        renderer.update(createElement(JsonView, { value, maxDepth: 2 }));
      });
      const second = renderedRows(renderer).map((row) => row.id);
      expect(second).toEqual(first);
      expect(new Set(second).size).toBe(second.length);
    } finally {
      await unmount(renderer);
    }
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

  test('initial expansion reuses the shared path encoder instead of rebuilding paths', () => {
    const source = src();
    expect(source).toContain('collectJsonTreeContainerPaths');
    // The old local builder concatenated `${path}.${entry.key}` / `${path}[${index}]`
    // a second time, which is how dotted and bracket keys aliased.
    expect(source).not.toContain('function collectRootPaths');
    expect(source).not.toMatch(/\$\{path\}\.\$\{entry\.key\}/);
    expect(source).not.toMatch(/\$\{path\}\[\$\{index\}\]/);
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
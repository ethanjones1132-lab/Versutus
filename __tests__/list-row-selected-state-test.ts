declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
  readdirSync(path: string, opts: { withFileTypes: boolean }): Array<{
    name: string;
    isDirectory(): boolean;
  }>;
};
const nodePath = jest.requireActual('path') as {
  join(...parts: string[]): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, ...parts].join(SEP), 'utf8');
}

function readListRowSource(): string {
  return readSource('..', 'src', 'components', 'ui', 'ListRow.tsx');
}

function readBackendsSource(): string {
  return readSource(
    '..',
    'src',
    'components',
    'chat',
    'thread-config-sheet.tsx',
  );
}

function listFilesWithListRow(dir: string, out: string[]): void {
  for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'ui') {
        listFilesWithListRow(full, out);
      }
      continue;
    }
    if (!full.endsWith('.tsx')) {
      continue;
    }
    const src = nodeFs.readFileSync(full, 'utf8');
    if (/<ListRow[\s>]/.test(src)) {
      out.push(full);
    }
  }
}

// The thread backend picker (thread-config-sheet.tsx:619-631) renders each
// backend as a `ListRow` with a visual selected treatment (an accent border
// when `item.id === selectedBackendId`) but `ListRow` took no `selected` prop
// and emitted no `accessibilityState` at all, so a screen reader heard a flat
// row with no hint which backend the thread will use. Adding an optional
// `selected` to the kit — forwarded defined-only, mirroring the `Button`
// defined-only pattern — and passing it at the backend call site lets
// VoiceOver/TalkBack announce "selected" on the picked backend.
describe('ListRow selected state screen-reader wiring', () => {
  test('the kit declares an optional selected prop on ListRowProps', () => {
    const src = readListRowSource();
    // Optional, so every existing call site compiles untouched and emits no
    // state — exactly as today.
    expect(src).toContain('selected?: boolean;');
  });

  test('the kit forwards selected defined-only into accessibilityState', () => {
    const src = readListRowSource();
    // Mirrors the Button defined-only pattern at Button.tsx:38: an undefined
    // selected spreads nothing, so rows that never pass it emit an empty
    // state object — no behaviour change for any other call site.
    expect(src).toMatch(
      /accessibilityState=\{\{\s*\.\.\.\(selected !== undefined \? \{ selected \} : null\)\s*\}\}/,
    );
  });

  test('the kit keeps role, label, and hint wiring byte-identical', () => {
    const src = readListRowSource();
    // The new state supplements the existing row semantics; it does not
    // replace them.
    expect(src).toContain(
      "accessibilityRole={interactive ? 'button' : undefined}",
    );
    // The derived label is unchanged for every caller that hands no
    // announcement of its own — only the `??` in front of it is new, and the
    // fallback below is the label this line has always produced.
    expect(src).toContain(
      'accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}',
    );
    expect(src).toContain('accessibilityHint={accessibilityHint}');
  });

  test('the backend picker passes selected bound to the picked backend', () => {
    const src = readBackendsSource();
    // The same boolean that drives the visible accent border now reaches the
    // screen reader — the announced state can never drift from the pixels.
    expect(src).toContain('selected={item.id === selectedBackendId}');
  });

  test('the backend selected border styling stays byte-identical', () => {
    const src = readBackendsSource();
    // The sighted treatment is what the new state mirrors; it must not move.
    expect(src).toContain(
      '? { borderColor: tokens.accentWarm, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: Radius.lg }',
    );
  });

  test('the backend onPress wiring stays byte-identical', () => {
    const src = readBackendsSource();
    // The tap still selects the backend; the new prop only announces it.
    expect(src).toContain('onPress={() => onSelect?.(item.id)}');
  });

  test('no other ListRow call site passes selected', () => {
    // The item scopes the pass to the BackendsSection call site only: every
    // other ListRow leaves selected undefined and emits no state, exactly as
    // today.
    const srcRoot = [__dirname, '..', 'src', 'components'].join(SEP);
    const withListRow: string[] = [];
    listFilesWithListRow(srcRoot, withListRow);
    // The kit file itself declares and forwards the prop but renders no row.
    const callSites = withListRow.filter(
      (file) => !file.endsWith('ui/ListRow.tsx'),
    );
    expect(callSites.length).toBeGreaterThan(0);
    const passing = callSites.filter((file) => {
      const src = nodeFs.readFileSync(file, 'utf8');
      return /<ListRow[\s\S]*?selected=\{/.test(src);
    });
    expect(passing).toEqual([
      nodePath.join(srcRoot, 'chat', 'thread-config-sheet.tsx'),
    ]);
  });
});

// `ListRow` announces a row with the string it draws, so a row drawn from a
// line composed to a budget — the Scorecards card's is (`scorecardCardLine`) —
// would drop the same facts from the sentence a screen reader reads as from the
// pixels. An optional announcement the kit reads verbatim is what lets such a
// row say the whole thing while drawing what fits; a row that hands none keeps
// the label it has always derived.
describe('ListRow announcement screen-reader wiring', () => {
  test('the kit declares an optional accessibilityLabel on ListRowProps', () => {
    const src = readListRowSource();
    // Optional, so every existing call site compiles untouched and announces
    // exactly what it draws — the label derived from title and subtitle.
    expect(src).toContain('accessibilityLabel?: string;');
  });

  test('a row handed an announcement reads it, and the drawn label is the fallback', () => {
    const src = readListRowSource();
    // ONE expression, so the two rules cannot drift: the handed string wins,
    // and everything else is the label this row announced before the prop
    // existed.
    expect(src).toContain(
      'accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}',
    );
    // The row still draws what it draws: the new prop is not a visual.
    expect(src).toContain('{subtitle}');
  });

  test('the scorecards card is the one caller that hands one', () => {
    // Scoped to the one surface that composes a budgeted line: every other
    // ListRow leaves accessibilityLabel undefined and derives its own label
    // exactly as today.
    const srcRoot = [__dirname, '..', 'src', 'components'].join(SEP);
    const withListRow: string[] = [];
    listFilesWithListRow(srcRoot, withListRow);
    const callSites = withListRow.filter(
      (file) => !file.endsWith('ui/ListRow.tsx'),
    );
    expect(callSites.length).toBeGreaterThan(0);
    const passing = callSites.filter((file) => {
      const src = nodeFs.readFileSync(file, 'utf8');
      return /<ListRow[\s\S]*?accessibilityLabel=\{/.test(src);
    });
    expect(passing).toEqual([
      nodePath.join(srcRoot, 'activity', 'scorecards-section.tsx'),
    ]);
  });
});

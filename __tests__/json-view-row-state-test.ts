declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readJsonViewSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'terminal', 'json-view.tsx'].join(SEP),
    'utf8',
  );
}

// The terminal JSON tree renders collapsible container rows
// (json-view.tsx:111-128) whose open/closed state lives on the container
// variant of JsonTreeRow (`open: boolean` at json-tree.ts:111, computed as
// `expanded.has(path)` at :130, driving the chevron at :136) — but RN's
// <Pressable> does not auto-emit accessibilityState, so a screen reader
// focused on a container row heard only the mono text and never the runtime
// expanded state. The container branch now binds it directly, mirroring the
// established run-card.tsx:135 / gateway-capabilities.tsx:48 /
// environment-card.tsx:53 / thread-config-sheet.tsx:500 pattern.
describe('JsonView container-row screen-reader state', () => {
  test('the container-row Pressable declares accessibilityState.expanded bound to row.open', () => {
    const src = readJsonViewSource();
    // Anchor on the container branch's unique onToggle handler so the match
    // scopes to the container row, not the primitive copy row.
    expect(src).toMatch(
      /<Pressable[\s\S]*?onPress=\{\(\) => onToggle\(row\.path\)\}[\s\S]*?accessibilityState=\{\{\s*expanded:\s*row\.open\s*\}\}[\s\S]*?style=/,
    );
  });

  test('the container-row Pressable keeps accessibilityRole="button" byte-identical', () => {
    const src = readJsonViewSource();
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the container-row Pressable keeps onToggle wiring byte-identical', () => {
    const src = readJsonViewSource();
    expect(src).toContain('onPress={() => onToggle(row.path)}');
  });

  test('the container chevron/preview brace rendering is byte-identical', () => {
    const src = readJsonViewSource();
    // The row's mono text is the announcement body; the new state prop must
    // not change what the row shows.
    expect(src).toContain('{row.chevron}');
    expect(src).toContain('{row.preview}');
    expect(src).toContain("'{…}'");
  });

  test('the primitive copy row does not grow an accessibilityState', () => {
    const src = readJsonViewSource();
    // The primitive branch copies on tap; it has no expanded state to
    // announce. Exactly one accessibilityState in the file pins the scope.
    const hits = src.match(/accessibilityState=/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  test('the primitive onCopy wiring is byte-identical', () => {
    const src = readJsonViewSource();
    expect(src).toContain('onPress={() => onCopy(row.value)}');
    expect(src).toContain('onLongPress={() => onCopy(row.value)}');
  });
});

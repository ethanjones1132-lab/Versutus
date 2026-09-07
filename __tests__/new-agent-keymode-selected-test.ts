declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readTypes(): string {
  return readSource(['src', 'components', 'ui', 'types.ts']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

function readButtonIos(): string {
  return readSource(['src', 'components', 'ui', 'Button.ios.tsx']);
}

function readNewAgentSheet(): string {
  return readSource(['src', 'components', 'chat', 'new-agent-sheet.tsx']);
}

// The inheritKeys toggle swaps its label between two key-set modes, but a
// screen-reader user heard the swapped label with no selected state while a
// sighted user saw the mode swap. The fix is a `selected` half on the kit
// `Button` (defined-only spread, like `expanded` and `busy`) wired once on
// this toggle.
describe('new-agent key-mode selected state', () => {
  test('the kit ButtonProps declares an optional selected half', () => {
    const src = readTypes();
    expect(src).toContain('selected?: boolean;');
  });

  test('the kit Button spreads selected only when defined', () => {
    const src = readButton();
    expect(src).toContain('...(selected !== undefined ? { selected } : null)');
  });

  test('a plain Button still never announces selected', () => {
    const src = readButton();
    expect(src).not.toContain('selected: !!');
    expect(src).not.toMatch(/accessibilityState=\{\{[^}]*\bselected,/);
  });

  test('the key-mode toggle passes selected={inheritKeys}', () => {
    const src = readNewAgentSheet();
    expect(src).toContain('selected={inheritKeys}');
  });

  test('the selected wiring lands exactly once in the sheet', () => {
    const src = readNewAgentSheet();
    expect(src.match(/selected=\{/g)?.length ?? 0).toBe(1);
  });

  test('the toggle label stays byte-identical', () => {
    const src = readNewAgentSheet();
    expect(src).toContain("label={inheritKeys ? 'Inherit keys from default' : 'Empty key set'}");
  });

  test('the toggle variant and flip handler stay byte-identical', () => {
    const src = readNewAgentSheet();
    expect(src).toContain('variant="ghost"');
    expect(src).toContain('onPress={() => setInheritKeys((value) => !value)}');
  });

  test('the Create/Save busy wiring stays byte-identical', () => {
    const src = readNewAgentSheet();
    expect(src).toContain('busy={busy}');
  });

  test('Button.ios.tsx stays byte-identical (no selected half)', () => {
    const src = readButtonIos();
    expect(src).not.toContain('selected');
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

function readTypes(): string {
  return readSource(['src', 'components', 'ui', 'types.ts']);
}

function readRoom(): string {
  return readSource(['src', 'components', 'chat', 'group-room-view.tsx']);
}

// The three group-room in-flight buttons (Send, Rename, Add to room) each
// hold a real boolean (sending, renaming, adding) that already swaps the
// label and disables the button — but `Button` announced only `disabled`,
// so a screen-reader user heard the swapped label with no busy state while
// a sighted user saw the in-flight label. The fix adds an optional `busy`
// to `ButtonProps`, spreads it into `accessibilityState` only when defined,
// and passes `busy={sending}` / `busy={renaming}` / `busy={adding}` on the
// three buttons — matching the `expanded` pattern the pane toggles use.
describe('group room busy state', () => {
  test('ButtonProps declares an optional busy boolean', () => {
    const src = readTypes();
    // Optional so a plain action Button never newly announces `busy`.
    expect(src).toMatch(/busy\?: boolean;/);
  });

  test('Button spreads busy into accessibilityState only when defined', () => {
    const src = readButton();
    // The defined-only spread keeps the `disabled` half byte-identical and
    // leaves plain Buttons without a `busy` key entirely.
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });

  test('Button still always announces the disabled half', () => {
    const src = readButton();
    expect(src).toContain('accessibilityState={{ disabled: !!isDisabled,');
  });

  test('Button destructures the busy prop', () => {
    const src = readButton();
    expect(src).toMatch(/expanded,\n\s+busy,\n\s+selected,\n\}: ButtonProps\)/);
  });

  test('the Send button passes busy={sending}', () => {
    const src = readRoom();
    expect(src).toContain('busy={sending}');
  });

  test('the Rename button passes busy={renaming}', () => {
    const src = readRoom();
    expect(src).toContain('busy={renaming}');
  });

  test('the Add button passes busy={adding}', () => {
    const src = readRoom();
    expect(src).toContain('busy={adding}');
  });

  test('each in-flight boolean wires busy exactly once', () => {
    const src = readRoom();
    for (const name of ['sending', 'renaming', 'adding']) {
      expect(src.match(new RegExp(`busy=\\{${name}\\}`, 'g'))?.length ?? 0).toBe(1);
    }
  });

  test('the three labels stay byte-identical', () => {
    const src = readRoom();
    expect(src).toContain("label={sending ? 'Round running…' : 'Send'}");
    expect(src).toContain("label={renaming ? 'Renaming…' : 'Rename'}");
    expect(src).toContain("label={adding ? 'Adding…' : 'Add to room'}");
  });

  test('the three disabled gates stay byte-identical', () => {
    const src = readRoom();
    expect(src).toContain('disabled={sending || !draft.trim()}');
    expect(src).toContain('disabled={renaming || !renameDraft.trim()}');
    expect(src).toContain('disabled={adding || addSelection.length === 0}');
  });

  test('the Disband confirmLabel stays byte-identical and now announces busy', () => {
    const src = readRoom();
    // `disbanding` lived only on the ConfirmSheet confirmLabel until the
    // ConfirmSheet busy item landed; it now also reaches the confirm Button
    // as `busy={disbanding}` via the new ConfirmSheet `busy` prop.
    expect(src).toContain("confirmLabel={disbanding ? 'Disbanding…' : 'Disband'}");
    expect(src).toContain('busy={disbanding}');
  });

  test('Button.ios.tsx stays untouched with no busy half', () => {
    const src = readSource(['src', 'components', 'ui', 'Button.ios.tsx']);
    expect(src).not.toContain('busy');
  });
});

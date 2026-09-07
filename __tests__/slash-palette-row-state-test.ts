declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readPaletteSource(): string {
  // Normalize line endings so the block regexes below do not depend on
  // the file's on-disk line-ending style.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'slash-command-palette.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// The slash-command palette renders one row per command
// (slash-command-palette.tsx:137-153). Each row is a PressableScale
// whose `disabled={item.unavailable}` prop gates the tap and whose
// `opacity: 0.55` dim is the sighted-only unavailable signal — but
// RN's <Pressable> does not auto-emit accessibilityState, so a screen
// reader focused on an unavailable row hears only "Command X, button"
// and never the disabled state. PressableScale spreads PressableProps
// (which includes accessibilityState) onto its inner Pressable, so
// adding the prop is a one-line call-site change that mirrors the
// established chat-composer.tsx:238 / chat-header.tsx:94 disabled-state
// pattern.
describe('Slash command palette unavailable-row screen-reader state', () => {
  test('each command row declares accessibilityState.disabled bound to item.unavailable', () => {
    const src = readPaletteSource();
    // Anchor on the row's unique `disabled={item.unavailable}` prop and
    // scope through to the row's `onSelect(item.value)` wiring so the
    // match cannot land on the inner description toggle (which uses
    // `expanded: descExpanded`, not `disabled`).
    expect(src).toMatch(
      /<PressableScale[\s\S]*?disabled=\{item\.unavailable\}[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityLabel=\{`Command \$\{item\.label\}`\}[\s\S]*?accessibilityState=\{\{\s*disabled:\s*item\.unavailable\s*\}\}[\s\S]*?onSelect\(item\.value\)/,
    );
  });

  test('the command row keeps accessibilityRole="button" byte-identical', () => {
    const src = readPaletteSource();
    // The role is what the screen reader uses to decide the control's
    // verb; accessibilityState supplements the role, it does not
    // replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the command row keeps the accessibilityLabel template byte-identical', () => {
    const src = readPaletteSource();
    // The label is the user-facing sentence the screen reader reads;
    // the new accessibilityState must not change what the row is
    // announced as — only what state it is in.
    expect(src).toContain('accessibilityLabel={`Command ${item.label}`}');
  });

  test('the command row keeps the disabled={item.unavailable} prop byte-identical', () => {
    const src = readPaletteSource();
    // The disabled prop is the real platform-disabled state the new
    // accessibilityState mirrors; it must not change.
    expect(src).toContain('disabled={item.unavailable}');
  });

  test('the command row keeps the onSelect wiring byte-identical', () => {
    const src = readPaletteSource();
    // The tap still selects the command value and closes the palette;
    // the new accessibilityState must not change which action fires on
    // tap — only what state is announced.
    expect(src).toContain('onSelect(item.value);');
    expect(src).toContain('onClose();');
  });

  test('the inner description toggle keeps its expanded state untouched', () => {
    const src = readPaletteSource();
    // The description toggle is the sibling state carrier in the same
    // file; the row fix must not touch its expanded binding, its
    // labels, or its stopPropagation guard.
    expect(src).toContain('accessibilityState={{ expanded: descExpanded }}');
    expect(src).toContain(
      "accessibilityLabel={descExpanded ? 'Collapse command description' : 'Expand command description'}",
    );
    expect(src).toContain('event.stopPropagation()');
  });

  test('exactly two accessibilityState carriers live in the palette file', () => {
    const src = readPaletteSource();
    // The two legitimate carriers are the command row
    // (`disabled: item.unavailable`) and the inner description toggle
    // (`expanded: descExpanded`). The search field and the section
    // headers carry none.
    const occurrences = src.match(/accessibilityState=\{\{/g) ?? [];
    expect(occurrences).toHaveLength(2);
  });
});

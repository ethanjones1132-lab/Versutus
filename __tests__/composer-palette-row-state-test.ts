declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readComposerSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-composer.tsx'].join(SEP),
    'utf8',
  );
}

// The chat composer renders one slash-suggestion row per match
// (chat-composer.tsx:221-269). Each row is a PressableScale whose
// `disabled={unavailable}` prop gates the tap behind an
// `if (!unavailable)` guard at :239 — but RN's <Pressable> does not
// auto-emit accessibilityState, so a screen reader focused on an
// unavailable suggestion hears only "Command X, button" and never
// the disabled state (the 0.55 dim plus the ` (unavailable)` suffix
// at :265 are the sighted signals). PressableScale spreads
// PressableProps (which includes accessibilityState) onto its inner
// Pressable, so adding the prop is a one-line call-site change that
// mirrors the established chat-composer.tsx:336 / chat-header.tsx:94
// disabled-state pattern.
describe('Chat composer slash-suggestion screen-reader state', () => {
  test('each suggestion row declares accessibilityState.disabled bound to unavailable', () => {
    const src = readComposerSource();
    // Anchor on the suggestion row's unique `if (!unavailable)` guard
    // to scope the match to the suggestion-row block (the Send/Stop
    // button at :323-356 uses `disabled={isActionDisabled}`; the
    // Browse-all-commands row at :271-295 carries no disabled prop).
    expect(src).toMatch(
      /<PressableScale[\s\S]*?disabled=\{unavailable\}[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityLabel=\{`Command \$\{item\.label\}`\}[\s\S]*?accessibilityState=\{\{\s*disabled:\s*unavailable\s*\}\}[\s\S]*?if \(!unavailable\)/,
    );
  });

  test('the suggestion row keeps accessibilityRole="button" byte-identical', () => {
    const src = readComposerSource();
    // The role is what the screen reader uses to decide the control's
    // verb; accessibilityState supplements the role, it does not
    // replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the suggestion row keeps the accessibilityLabel template byte-identical', () => {
    const src = readComposerSource();
    // The label is the user-facing sentence the screen reader reads;
    // the new accessibilityState must not change what the row is
    // announced as — only what state it is in.
    expect(src).toContain('accessibilityLabel={`Command ${item.label}`}');
  });

  test('the suggestion row keeps the disabled={unavailable} prop byte-identical', () => {
    const src = readComposerSource();
    // The disabled prop is the real platform-disabled state the new
    // accessibilityState mirrors; it must not change.
    expect(src).toContain('disabled={unavailable}');
  });

  test('the suggestion row keeps the if (!unavailable) onPress guard byte-identical', () => {
    const src = readComposerSource();
    // The guard is what actually suppresses the tap on an unavailable
    // suggestion; the new accessibilityState must not change which
    // action fires on tap — only what state is announced.
    expect(src).toContain('if (!unavailable) {');
  });

  test('the sibling Browse-all-commands row stays actionable and stateless', () => {
    const src = readComposerSource();
    // The Browse row is always actionable (no disabled prop) and
    // correctly carries no accessibilityState — it has no boolean
    // state to announce. Its label must stay byte-identical.
    expect(src).toContain('accessibilityLabel="Browse all commands"');
    const labelIdx = src.indexOf('accessibilityLabel="Browse all commands"');
    const blockStart = src.lastIndexOf('<PressableScale', labelIdx);
    const blockEnd = src.indexOf('</PressableScale>', labelIdx);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(labelIdx);
    const browseBlock = src.slice(blockStart, blockEnd);
    expect(browseBlock).toBeDefined();
    expect(browseBlock).not.toMatch(/disabled=\{/);
    expect(browseBlock).not.toMatch(/accessibilityState=\{\{/);
  });

  test('exactly two accessibilityState carriers live in the composer file', () => {
    const src = readComposerSource();
    // The two legitimate carriers are the Send/Stop button
    // (`disabled: isActionDisabled, busy: isStreaming` at :336) and
    // the suggestion row (`disabled: unavailable`). The quick-action
    // chips and mention picks carry none.
    const occurrences = src.match(/accessibilityState=\{\{/g) ?? [];
    expect(occurrences).toHaveLength(2);
  });
});

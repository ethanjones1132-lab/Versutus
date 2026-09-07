declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readToolCallCardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'tool-call-card.tsx'].join(SEP),
    'utf8',
  );
}

// The ToolCallCard Detail toggle PressableScale (tool-call-card.tsx:58-68)
// toggles the detail expansion via `setDetailUserOverride` at line 61, and
// `isDetailExpanded` (derived at :34-38 from `detailUserOverride` with the
// documented error-falls-open rule) already gates the detail card at :69, but
// the toggle declares no role, label, or state. A VoiceOver/TalkBack user
// therefore hears the Detail/Hide-detail caption with no announcement of
// whether the detail is currently open. PressableScale spreads PressableProps
// (which includes accessibilityState) onto its inner Pressable, so adding the
// props is a call-site-only change.
describe('ToolCallCard Detail toggle screen-reader state', () => {
  test('the Detail PressableScale declares accessibilityState.expanded bound to isDetailExpanded', () => {
    const src = readToolCallCardSource();
    // The Detail toggle PressableScale block at :58-68 must carry an
    // accessibilityState prop whose expanded value mirrors `isDetailExpanded`
    // — the same value that already drives the caption ternary at :66 and the
    // detail card gate at :69.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?accessibilityState=\{\{\s*expanded:\s*isDetailExpanded\s*\}\}[\s\S]*?style=\{styles\.detailToggle\}/,
    );
  });

  test('the Detail PressableScale keeps accessibilityRole="button" byte-identical', () => {
    const src = readToolCallCardSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the Detail PressableScale keeps a text-mirroring accessibilityLabel', () => {
    const src = readToolCallCardSource();
    // The label mirrors the visible caption so the announced name always
    // matches what sighted users see.
    expect(src).toContain(
      "accessibilityLabel={isDetailExpanded ? 'Hide detail' : 'Detail'}",
    );
  });

  test('the Detail PressableScale keeps the error-falls-open derivation byte-identical', () => {
    const src = readToolCallSourceDerivation();
    // The derivation is what actually decides the state; the new
    // accessibilityState must follow it, not bypass it.
    expect(src).toMatch(/detailUserOverride !== null/);
    expect(src).toMatch(/toolCall\.status === 'error'/);
  });

  test('the Detail PressableScale keeps the two-line clipped preview byte-identical', () => {
    const src = readToolCallCardSource();
    // The collapsed preview is what sighted users see under the toggle: the
    // two-line-clipped detail. The new accessibility props must not touch it.
    expect(src).toMatch(/numberOfLines=\{2\}[\s\S]*?toolCall\.detail/);
  });

  test('the status Badge stays untouched', () => {
    const src = readToolCallCardSource();
    // The Badge names the call status (Running/Done/Failed); the toggle change
    // must not rename it.
    expect(src).toMatch(
      /<Badge label=\{STATUS_LABEL\[status\]\} tone=\{STATUS_TONE\[status\]\} dot=\{false\} \/>/,
    );
  });

  test('accessibilityState appears only on the Detail toggle', () => {
    const src = readToolCallCardSource();
    // ToolCallCard renders a single PressableScale (the Detail toggle gated on
    // `toolCall.detail`); the state prop must live on it and nowhere else.
    const allPressables = src.match(/<PressableScale[\s\S]*?\/PressableScale>/g) ?? [];
    const stateCarriers = allPressables.filter((p) =>
      /accessibilityState=\{\{/.test(p),
    );
    expect(stateCarriers).toHaveLength(1);
  });
});

function readToolCallSourceDerivation(): string {
  return readToolCallCardSource();
}

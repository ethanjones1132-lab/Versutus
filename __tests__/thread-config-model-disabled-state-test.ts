declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readThreadConfigSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'thread-config-sheet.tsx'].join(SEP),
    'utf8',
  );
}

function readNewAgentSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'new-agent-sheet.tsx'].join(SEP),
    'utf8',
  );
}

// The thread-config model card renders with `disabled={item.available ===
// false}` and dims to `opacity: 0.6`, yet its accessibilityState carried only
// `{ selected: isCurrent }` — half-announced against the sibling
// new-agent-sheet.tsx:165 precedent `{{ selected, disabled:
// item.available === false }}` for the same condition. The fix extends the
// model card's state object with the disabled half; PressableScale spreads
// PressableProps onto its inner Pressable so the prop just works.
describe('Thread-config model-card disabled screen-reader state', () => {
  test('the model card declares accessibilityState.disabled bound to item.available === false', () => {
    const src = readThreadConfigSource();
    // Anchor on the model card's unique label so the match cannot land on
    // the session card (selected-only) or the section header (expanded).
    expect(src).toMatch(
      /accessibilityLabel=\{`Apply model \$\{name\}`\}[\s\S]*?accessibilityState=\{\{\s*selected:\s*isCurrent,\s*disabled:\s*item\.available === false\s*\}\}/,
    );
  });

  test('the model card keeps the selected half of the state object', () => {
    const src = readThreadConfigSource();
    // The disabled half must join the selected wiring, not replace it — the
    // Current Badge and warm border still follow isCurrent.
    expect(src).toMatch(/accessibilityState=\{\{\s*selected:\s*isCurrent,/);
  });

  test('the new-agent-sheet precedent still carries the full selected+disabled shape', () => {
    const src = readNewAgentSource();
    // The precedent this fix mirrors; if it drifts, this item's rationale
    // needs re-checking rather than a blind pin update.
    expect(src).toContain('accessibilityState={{ selected, disabled: item.available === false }}');
  });

  test('the Apply model label stays byte-identical', () => {
    const src = readThreadConfigSource();
    expect(src).toContain('accessibilityLabel={`Apply model ${name}`}');
  });

  test('the disabled gate stays byte-identical', () => {
    const src = readThreadConfigSource();
    // The tap gate and the announced state must read the same boolean or the
    // announcement lies about what a tap will do.
    expect(src).toContain('disabled={item.available === false}');
  });

  test('the 0.6 dim stays byte-identical', () => {
    const src = readThreadConfigSource();
    // The sighted-only cue the announcement now mirrors.
    expect(src).toContain('opacity: item.available === false ? 0.6 : 1');
  });

  test('the session card stays selected-only with no disabled half', () => {
    const src = readThreadConfigSource();
    // The session card is never disabled, so its state object must not grow
    // a disabled key — anchor on its unique label.
    expect(src).toMatch(
      /accessibilityLabel=\{`Switch to session \$\{sessionListTitle\(item\.title\)\}`\}[\s\S]*?accessibilityState=\{\{\s*selected:\s*isCurrent\s*\}\}/,
    );
  });

  test('exactly three accessibilityState props exist in the file', () => {
    const src = readThreadConfigSource();
    // Session card + model card (this item) + the section-header expanded
    // state (iter-145). The fix extends the model card's object in place, so
    // the count must not move. The session-delete button must not grow one.
    const states = src.match(/accessibilityState=/g) ?? [];
    expect(states.length).toBe(3);
  });
});

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

// The thread-config sheet renders two picker cards that already know which
// entry is current: the session card binds `isCurrent = item.id ===
// currentSessionId` (:189, driving borderColor at :209 and the Current Badge
// at :223) and the model card binds `isCurrent = sameModelId(item.id,
// currentDefault) || ...` (:432, driving borderColor at :450 and the Current
// Badge at :465-466). The session card carries selected-only state; the model
// card carries selected + disabled (the disabled half landed after this file
// was written — see thread-config-model-disabled-state-test.ts). PressableScale
// spreads PressableProps (which includes accessibilityState) onto its inner
// Pressable, so binding the existing boolean is a one-line call-site change
// per card, mirroring the run-card.tsx:135 / gateway-capabilities.tsx:48 /
// environment-card.tsx:53 expanded pattern with `selected` instead.
describe('Thread-config picker-card screen-reader state', () => {
  test('the session card declares accessibilityState.selected bound to isCurrent', () => {
    const src = readThreadConfigSource();
    // Anchor on the session card's unique label so the match cannot land on
    // the model card or the section header (which use different labels).
    expect(src).toMatch(
      /accessibilityLabel=\{`Switch to session \$\{sessionListTitle\(item\.title\)\}`\}[\s\S]*?accessibilityState=\{\{\s*selected:\s*isCurrent\s*\}\}/,
    );
  });

  test('the model card declares accessibilityState.selected bound to isCurrent', () => {
    const src = readThreadConfigSource();
    // Anchor on the model card's unique label so the match cannot land on
    // the session card or the section header. The state object also carries
    // disabled (see thread-config-model-disabled-state-test.ts) so the pin
    // allows the trailing disabled half after selected.
    expect(src).toMatch(
      /accessibilityLabel=\{`Apply model \$\{name\}`\}[\s\S]*?accessibilityState=\{\{\s*selected:\s*isCurrent,\s*disabled:\s*item\.available === false\s*\}\}/,
    );
  });

  test('both cards keep accessibilityRole="button" byte-identical', () => {
    const src = readThreadConfigSource();
    // Both cards are tappable rows; the role is what the screen reader uses
    // for the control verb. accessibilityState supplements it.
    const roles = src.match(/accessibilityRole="button"/g) ?? [];
    // Session card, session-delete button, model card, section header.
    expect(roles.length).toBe(4);
  });

  test('both picker labels stay byte-identical', () => {
    const src = readThreadConfigSource();
    expect(src).toContain('accessibilityLabel={`Switch to session ${sessionListTitle(item.title)}`}');
    expect(src).toContain('accessibilityLabel={`Apply model ${name}`}');
  });

  test('the model card keeps disabled={item.available === false} byte-identical', () => {
    const src = readThreadConfigSource();
    // The disabled gate dims unavailable models; the new selected state must
    // follow isCurrent, not bypass the availability gate.
    expect(src).toContain('disabled={item.available === false}');
  });

  test('the session-delete gate stays byte-identical', () => {
    const src = readThreadConfigSource();
    // The delete affordance must never appear on the current session; the new
    // selected state must not change which rows offer deletion.
    expect(src).toContain('onDeleteSession && !isCurrent');
    expect(src).toContain('accessibilityLabel={`Delete session ${sessionListTitle(item.title)}`}');
  });

  test('exactly three accessibilityState props exist in the file', () => {
    const src = readThreadConfigSource();
    // Session card + model card (this item) + the section-header expanded
    // state (iter-145). The session-delete button must not grow one.
    const states = src.match(/accessibilityState=/g) ?? [];
    expect(states.length).toBe(3);
  });
});

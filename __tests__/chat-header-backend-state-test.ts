declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatHeaderSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-header.tsx'].join(SEP),
    'utf8',
  );
}

// The chat header's backend title PressableScale (chat-header.tsx:90-95) declares
// its purpose via the ternary `accessibilityLabel` (which is set only when
// `backendLabel` is truthy and reads "Chat backend: <name>. Change backend.") and
// gates its press with `disabled={!onBackendPress || !backendLabel}` (so the
// visible Pressable is dimmed and unpressable when no backend is connected), but
// never forwards either signal as `accessibilityState` — so a VoiceOver/TalkBack
// user focused on the header hears "Chat backend: foo. Change backend." or
// hears nothing at all (the role drops to `undefined` and the label drops to
// `undefined` when no backend is connected) without the actionable disabled
// readout. PressableScale spreads PressableProps (which includes
// accessibilityState) onto its inner Pressable, so adding the prop is a
// one-line call-site change that mirrors the established chat-composer.tsx:336
// pattern from iter-135.
describe('Chat header backend title screen-reader state', () => {
  test('the backend-title PressableScale declares accessibilityState.disabled bound to the disabled condition', () => {
    const src = readChatHeaderSource();
    // The PressableScale block at :90-95 must carry an accessibilityState
    // prop whose disabled value mirrors the existing `disabled` prop — the
    // same condition the platform uses for the press gate, so VoiceOver/
    // TalkBack can announce the dimmed/unpressable state to the user.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?disabled=\{!onBackendPress \|\| !backendLabel\}[\s\S]*?accessibilityState=\{\{\s*disabled:\s*!onBackendPress \|\| !backendLabel\s*\}\}[\s\S]*?\/>/,
    );
  });

  test('the backend-title PressableScale keeps accessibilityLabel byte-identical', () => {
    const src = readChatHeaderSource();
    // The label is the user-facing sentence the screen reader reads; the new
    // accessibilityState must not change what the button is announced as —
    // only what state it is in. The label is a ternary (drops to undefined
    // when no backend is connected), so the pin is the literal source line.
    expect(src).toContain(
      'accessibilityLabel={backendLabel ? `Chat backend: ${backendLabel}. Change backend.` : undefined}',
    );
  });

  test('the backend-title PressableScale keeps accessibilityRole ternary byte-identical', () => {
    const src = readChatHeaderSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it. The
    // role itself drops to `undefined` when no backend is connected so the
    // Pressable is no longer announced as a button — that ternary is part
    // of the existing wiring and must stay byte-identical.
    expect(src).toContain(
      'accessibilityRole={backendLabel && onBackendPress ? \'button\' : undefined}',
    );
  });

  test('the backend-title PressableScale keeps disabled ternary byte-identical', () => {
    const src = readChatHeaderSource();
    // The visible disabled prop is what suppresses onPress when no backend
    // is connected — accessibilityState.disabled must mirror it exactly,
    // not replace it (a discrepancy would be a lie to the screen reader).
    expect(src).toContain('disabled={!onBackendPress || !backendLabel}');
  });

  test('the backend-title PressableScale keeps the visible Text headlines byte-identical', () => {
    const src = readChatHeaderSource();
    // The visible UI is what sighted users see inside the press target —
    // the <Text variant="headline"> title and the <Text variant="micro">
    // streaming/subtitle line. The new accessibilityState must not change
    // either of them.
    expect(src).toContain('<Text variant="headline" numberOfLines={1} style={styles.name}>');
    expect(src).toContain(
      "streaming\n          ? 'Streaming response…'\n          : backendLabel || groupName?.trim()\n            ? `via ${gatewayName}${statusDetail ? ` · ${statusDetail}` : ''}`\n            : statusDetail || 'Ready for chat and slash commands'",
    );
  });

  test('accessibilityState appears on the backend-title PressableScale and is not duplicated on surrounding controls', () => {
    const src = readChatHeaderSource();
    // Only the backend-title PressableScale carries an accessibilityState
    // prop. The other PressableScale blocks in the file (Back to roster at
    // :75-87 and Chat options at :126-139) are flat navigation buttons
    // with no state to announce and must remain accessibilityRole="button"
    // with no accessibilityState. The exclusivity pin guards against a
    // future change that accidentally grows a state prop on the wrong
    // button.
    const backendBlock = src.match(
      /onPress=\{onBackendPress\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(backendBlock).toBeDefined();
    expect(backendBlock).toMatch(
      /accessibilityState=\{\{\s*disabled:\s*!onBackendPress \|\| !backendLabel\s*\}\}/,
    );

    // Ensure no other PressableScale in the file carries the same state
    // tuple (the Back-to-roster and Chat-options buttons must NOT grow an
    // accessibilityState prop).
    const allPressables = src.match(/<PressableScale[\s\S]*?\/>/g) ?? [];
    const stateCarriers = allPressables.filter((p) =>
      /accessibilityState=\{\{/.test(p),
    );
    expect(stateCarriers).toHaveLength(1);
  });
});
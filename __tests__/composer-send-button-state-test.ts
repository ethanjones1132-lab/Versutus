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

// The chat composer's Send/Stop PressableScale (chat-composer.tsx:323-355) declares
// its purpose via `accessibilityLabel={copy.sendLabel}` (which toggles between
// "Send message" / "Stop streaming" / "Queue message" via composerCopy) and
// gates its press with `disabled={isActionDisabled}` (computed from
// `!canSend || (!isStreaming && !draft.trim())` at line 80), but never forwards
// either signal as `accessibilityState` — so a VoiceOver/TalkBack user hears the
// label without the actionable hint or the streaming-busy readout. PressableScale
// spreads PressableProps (which includes accessibilityState) onto its inner
// Pressable, so adding the prop is a one-line call-site change.
describe('Chat composer Send/Stop button screen-reader state', () => {
  test('the Send/Stop PressableScale declares accessibilityState with disabled and busy', () => {
    const src = readComposerSource();
    // The PressableScale block at :323-355 must carry an accessibilityState
    // prop whose disabled mirrors the existing `disabled={isActionDisabled}`
    // prop and whose busy mirrors `isStreaming` — the two flags that change
    // what the screen reader user needs to hear.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?disabled=\{isActionDisabled\}[\s\S]*?accessibilityLabel=\{copy\.sendLabel\}[\s\S]*?accessibilityState=\{\{\s*disabled:\s*isActionDisabled,\s*busy:\s*isStreaming\s*\}\}[\s\S]*?onPressIn/,
    );
  });

  test('the Send/Stop PressableScale keeps accessibilityLabel={copy.sendLabel} byte-identical', () => {
    const src = readComposerSource();
    // The label string is the user-facing sentence the screen reader reads;
    // the new accessibilityState must not change what the button is announced
    // as — only what state it is in.
    expect(src).toContain('accessibilityLabel={copy.sendLabel}');
  });

  test('the Send/Stop PressableScale keeps accessibilityRole="button" byte-identical', () => {
    const src = readComposerSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the Send/Stop PressableScale keeps disabled={isActionDisabled} byte-identical', () => {
    const src = readComposerSource();
    // The visible disabled prop is what suppresses onPress when the composer
    // is empty or the gateway is offline — accessibilityState.disabled must
    // mirror it, not replace it.
    expect(src).toContain('disabled={isActionDisabled}');
  });

  test('the Send/Stop PressableScale keeps onPress={() => void handleAction()} byte-identical', () => {
    const src = readComposerSource();
    // The handler is what makes the button actually do something; the new
    // accessibilityState must not change which action fires on tap.
    expect(src).toContain('onPress={() => void handleAction()}');
  });

  test('the Send/Stop PressableScale keeps the onPressIn/onPressOut send-width animation byte-identical', () => {
    const src = readComposerSource();
    // The spring-driven sendWidth animation on onPressIn/onPressOut is the
    // visible button press feedback; the new accessibilityState must not
    // touch it. Both the Reanimated shared-value assignments and the
    // springSnappy preset must be intact.
    expect(src).toContain(
      'sendWidth.value = withSpring(isStreaming ? 68 : 52, springSnappy);',
    );
    expect(src).toContain(
      'sendWidth.value = withSpring(56, springSnappy);',
    );
  });

  test('accessibilityState appears on the Send/Stop PressableScale and is not duplicated on surrounding controls', () => {
    const src = readComposerSource();
    // Only the Send/Stop PressableScale carries an accessibilityState prop.
    // The other PressableScale controls in the composer (quick-action chips,
    // slash-suggestion rows, mention picks) are flat navigation buttons with
    // no state to announce and must remain accessibilityRole="button" with
    // no accessibilityState.
    const sendBlock = src.match(/<PressableScale[\s\S]*?sendWidth\.value = withSpring\(56, springSnappy\);[\s\S]*?<\/PressableScale>/)?.[0];
    expect(sendBlock).toBeDefined();
    expect(sendBlock).toMatch(
      /accessibilityState=\{\{\s*disabled:\s*isActionDisabled,\s*busy:\s*isStreaming\s*\}\}/,
    );
    // Ensure no other PressableScale in the file carries the same state
    // tuple (the chip rows must NOT grow an accessibilityState prop).
    const allPressables = src.match(/<PressableScale[\s\S]*?\/>/g) ?? [];
    const stateCarriers = allPressables.filter((p) =>
      /accessibilityState=\{\{/.test(p),
    );
    expect(stateCarriers).toHaveLength(1);
  });
});
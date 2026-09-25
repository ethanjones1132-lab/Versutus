declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readMessageBubbleSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'message-bubble.tsx'].join(SEP),
    'utf8',
  );
}

// The MessageBubble activity toggle (tools + thinking, collapsed to one quiet
// line) flips `setActivityUserOverride`; the raw toggle flips `setRawOpen`;
// `isActivityOpen` (derived from `activityUserOverride` with a streaming
// fallback) and `rawOpen` (useState) gate the activity card and the raw card,
// but neither toggle declared a role, label, or state. A VoiceOver/TalkBack
// user therefore heard the captions with no announcement of whether each card
// is open. PressableScale spreads PressableProps (which includes
// accessibilityState) onto its inner Pressable, so the props are a
// call-site-only change.
describe('MessageBubble activity/raw toggles screen-reader state', () => {
  test('the activity PressableScale declares accessibilityState.expanded bound to isActivityOpen', () => {
    const src = readMessageBubbleSource();
    // The activity toggle block must carry an accessibilityState prop whose
    // expanded value mirrors `isActivityOpen` — the same value that already
    // gates the activity card.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?accessibilityState=\{\{\s*expanded:\s*isActivityOpen\s*\}\}[\s\S]*?style=\{styles\.activityToggle\}/,
    );
  });

  test('the raw PressableScale declares accessibilityState.expanded bound to rawOpen', () => {
    const src = readMessageBubbleSource();
    // The raw toggle block must carry an accessibilityState prop whose
    // expanded value mirrors `rawOpen` — the same value that already drives
    // the caption ternary and the raw card gate.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?accessibilityState=\{\{\s*expanded:\s*rawOpen\s*\}\}[\s\S]*?style=\{styles\.rawButton\}/,
    );
  });

  test('both toggles declare accessibilityRole="button"', () => {
    const src = readMessageBubbleSource();
    // The role is what the screen reader uses to decide each control's verb;
    // accessibilityState supplements the role, it does not replace it.
    const roles = src.match(/accessibilityRole="button"/g) ?? [];
    expect(roles.length).toBeGreaterThanOrEqual(2);
  });

  test('both toggles keep text-mirroring accessibilityLabels', () => {
    const src = readMessageBubbleSource();
    // Each label mirrors its visible caption so the announced name always
    // matches what sighted users read (the `›` chevron is a sighted-only
    // affordance and stays out of the spoken name).
    expect(src).toContain('accessibilityLabel={activityLabel}');
    expect(src).toContain("accessibilityLabel={rawOpen ? 'Hide raw' : 'Raw'}");
  });

  test('both toggle captions stay byte-identical', () => {
    const src = readMessageBubbleSource();
    // The visible captions are what sighted users read; the accessibility
    // props must not rename them.
    expect(src).toContain('{activityLabel}');
    expect(src).toContain("{rawOpen ? 'Hide raw' : 'Raw'}");
  });

  test('both gated cards stay byte-identical', () => {
    const src = readMessageBubbleSource();
    // The cards the toggles gate must render exactly as before.
    expect(src).toMatch(/\{isActivityOpen \? \([\s\S]*?styles\.activityCard/);
    expect(src).toMatch(/\{rawOpen \? \([\s\S]*?styles\.rawCard/);
  });

  test('the haptics calls on both toggles stay byte-identical', () => {
    const src = readMessageBubbleSource();
    // The activity toggle fires a Light haptic before flipping the override;
    // the raw toggle is a plain state flip with no haptic.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?Haptics\.impactAsync\(Haptics\.ImpactFeedbackStyle\.Light\)[\s\S]*?style=\{styles\.activityToggle\}/,
    );
    expect(src).toContain('onPress={() => setRawOpen((open) => !open)}');
  });

  test('the interrupted Resume control stays byte-identical', () => {
    const src = readMessageBubbleSource();
    // Resume (interrupted) is a separate action pair (interrupted send
    // again); the expanded change must not touch it.
    expect(src).toMatch(/\{isInterrupted && onResume \? \([\s\S]*?style=\{styles\.actionButton\}/);
    expect(src).toContain('{interruptedSendAgainLabel()}');
  });

  test('accessibilityState.expanded appears exactly twice', () => {
    const src = readMessageBubbleSource();
    // MessageBubble renders exactly two expanded toggles (activity + raw);
    // the state prop must live on those two and nowhere else.
    const carriers = src.match(/accessibilityState=\{\{\s*expanded:/g) ?? [];
    expect(carriers).toHaveLength(2);
  });
});

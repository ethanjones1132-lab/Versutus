declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readAddGatewaySource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'app', 'gateway', 'add.tsx'].join(SEP),
    'utf8',
  );
}

// The manual-add-gateway Advanced options toggle (add.tsx:259-263) flips the
// `expanded` prop (backed by the `showAdvanced` useState at :32) to expose the
// Token / Session-key / Agent-ID fields at :265. The label already swaps
// between "Hide advanced" and "Advanced options" but RN's <Pressable> does not
// auto-emit accessibilityState, so a screen reader only hears the static label
// without the runtime state. Adding `accessibilityState={{ expanded }}`
// alongside the role and label lets VoiceOver/TalkBack announce "expanded" /
// "collapsed" — matching the established accessibilityState pattern.
describe('AddGateway Advanced options toggle screen-reader state', () => {
  test('the toggle Pressable declares accessibilityState.expanded bound to expanded', () => {
    const src = readAddGatewaySource();
    // The toggle block at :259-263 must carry an accessibilityState whose
    // expanded value mirrors the `expanded` prop — the same value that drives
    // the visible caption ternary and the :265 field gate.
    expect(src).toMatch(
      /<Pressable[\s\S]*?accessibilityState=\{\{\s*expanded\s*\}\}[\s\S]*?Advanced options/,
    );
  });

  test('the toggle Pressable keeps accessibilityRole="button" byte-identical', () => {
    const src = readAddGatewaySource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the toggle Pressable keeps a text-mirroring accessibilityLabel', () => {
    const src = readAddGatewaySource();
    // The label mirrors the visible caption so the announced name always
    // matches what sighted users see.
    expect(src).toContain(
      "accessibilityLabel={expanded ? 'Hide advanced' : 'Advanced options'}",
    );
  });

  test('the toggle caption ternary stays byte-identical', () => {
    const src = readAddGatewaySource();
    // The visible caption is what sighted users see inside the press target;
    // the new accessibility props must not change it.
    expect(src).toContain("{expanded ? 'Hide advanced' : 'Advanced options'}");
  });

  test('the toggle handler still flips expanded via onExpandedChange', () => {
    const src = readAddGatewaySource();
    // The handler is what actually flips the state; the new accessibilityState
    // must not change which action fires on tap.
    expect(src).toMatch(/onPress=\{\(\) => onExpandedChange\(!expanded\)\}/);
  });

  test('the showAdvanced-gated identify params stay untouched', () => {
    const src = readAddGatewaySource();
    // The expanded fields feed the saved gateway profile only when advanced is
    // open; the toggle change must not touch the save path.
    expect(src).toContain('sessionKey: showAdvanced ? sessionKey : undefined,');
    expect(src).toContain('agentId: showAdvanced ? agentId : undefined,');
  });

  test('accessibilityState appears on the toggle Pressable and nowhere else', () => {
    const src = readAddGatewaySource();
    // Only the Advanced options toggle carries accessibilityState. The screen
    // has no other Pressable to worry about — exclusivity pin guards against
    // a future change that grows a state prop on the wrong control.
    const stateCount = (src.match(/accessibilityState=/g) ?? []).length;
    expect(stateCount).toBe(1);
  });
});

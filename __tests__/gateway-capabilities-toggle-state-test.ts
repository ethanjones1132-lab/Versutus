declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGatewayCapabilitiesSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'gateway-capabilities.tsx'].join(SEP),
    'utf8',
  );
}

// The GatewayCapabilities card on the dashboard carries a Pressable toggle
// (gateway-capabilities.tsx:45-49) that flips `showAll` (useState(false) at
// :12) to expose the unready capability groups beyond the visible six. The
// label already swaps between "Hide unsupported capabilities" and "Show all
// capabilities" but RN's <Pressable> does not auto-emit accessibilityState,
// so a screen reader only hears the static label without the runtime state.
// Adding `accessibilityState={{ expanded: showAll }}` directly below the
// label lets VoiceOver/TalkBack announce "expanded" / "collapsed" alongside
// the existing role and label — matching the established iter-133/135/136/140
// accessibilityState pattern that gates the same Pressable-on-state shape.
describe('GatewayCapabilities show-all toggle screen-reader state', () => {
  test('the Pressable declares accessibilityState.expanded bound to showAll', () => {
    const src = readGatewayCapabilitiesSource();
    // The toggle block at :45-49 must carry an accessibilityState whose
    // expanded value mirrors the useState(false) at :12 — the same value
    // that drives the visible `visible` ternary at :25.
    expect(src).toMatch(
      /<Pressable[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityLabel=\{showAll \? 'Hide unsupported capabilities' : 'Show all capabilities'\}[\s\S]*?accessibilityState=\{\{\s*expanded:\s*showAll\s*\}\}[\s\S]*?\/>/,
    );
  });

  test('the Pressable keeps accessibilityRole="button" byte-identical', () => {
    const src = readGatewayCapabilitiesSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it.
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the Pressable keeps the accessibilityLabel ternary byte-identical', () => {
    const src = readGatewayCapabilitiesSource();
    // The label is the user-facing sentence the screen reader reads; the new
    // accessibilityState must not change what the button is announced as —
    // only what state it is in. The label is the ternary that swaps on the
    // same boolean as accessibilityState, so the pin is the literal string.
    expect(src).toContain(
      "accessibilityLabel={showAll ? 'Hide unsupported capabilities' : 'Show all capabilities'}",
    );
  });

  test('the Pressable keeps setShowAll((value) => !value) byte-identical', () => {
    const src = readGatewayCapabilitiesSource();
    // The handler is what actually flips the state; the new accessibilityState
    // must not change which action fires on tap. The visible expansion is
    // driven by this handler, so accessibilityState.expanded must follow it,
    // not bypass it.
    expect(src).toMatch(/setShowAll\(\(value\) => !value\)/);
  });

  test('the useState hook still declares the boolean default false', () => {
    const src = readGatewayCapabilitiesSource();
    // The initial collapse keeps the grid trimmed to six rows by default.
    // The toggle flips it.
    expect(src).toMatch(/const \[showAll, setShowAll\] = useState\(false\);/);
  });

  test('the visible label ternary byte-identical across all three branches', () => {
    const src = readGatewayCapabilitiesSource();
    // The visible label is what sighted users see inside the press target;
    // it must not change. The ternary branches are "Hide unsupported" /
    // `Show ${hiddenCount} not offered` / "Show unsupported".
    expect(src).toContain("'Hide unsupported'");
    expect(src).toContain('`Show ${hiddenCount} not offered`');
    expect(src).toContain("'Show unsupported'");
  });

  test('the otherGroups.length > 0 gate that decides whether the toggle renders is byte-identical', () => {
    const src = readGatewayCapabilitiesSource();
    // The toggle only renders when there is something to expand into — a
    // connected Gate with all capabilities ready never shows it. The new
    // accessibilityState must not change the gate that decides whether the
    // toggle exists at all.
    expect(src).toMatch(/\{otherGroups\.length > 0 \?\s*\(/);
  });

  test('accessibilityState appears on the toggle Pressable and nowhere else', () => {
    const src = readGatewayCapabilitiesSource();
    // Only the toggle Pressable carries accessibilityState. The card has no
    // other Pressable/PressableScale to worry about — exclusivity pin guards
    // against a future change that accidentally grows a state prop on the
    // wrong control (or duplicates the prop on this one).
    const toggleBlock = src.match(
      /<Pressable[\s\S]*?accessibilityState=\{\{\s*expanded:\s*showAll\s*\}\}[\s\S]*?\/>/,
    )?.[0];
    expect(toggleBlock).toBeDefined();
    const stateCount = (src.match(/accessibilityState=/g) ?? []).length;
    expect(stateCount).toBe(1);
  });
});
declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readEnvironmentCardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'environment-card.tsx'].join(SEP),
    'utf8',
  );
}

// The EnvironmentCard on the Environments tab carries two PressableScale blocks
// that toggle `policyExpanded` (workspace policy, environment-card.tsx:25) and
// `providersExpanded` (bound providers, environment-card.tsx:26) — both feed a
// `numberOfLines` clamp on the visible <Text>. The PressableScale at :45-54
// declares `accessibilityRole="button"` and a static label that does NOT swap
// on the toggle, so a screen reader only hears "Workspace policy for X"
// without the runtime expanded state. PressableScale spreads `...props` onto
// the inner AnimatedPressable (PressableScale.tsx:20), which accepts
// `accessibilityState` via PressableProps, so the fix is a per-block
// `accessibilityState={{ expanded: ... }}` placed right below the role.
describe('EnvironmentCard toggle screen-reader state', () => {
  test('the workspace-policy PressableScale declares accessibilityState.expanded bound to policyExpanded', () => {
    const src = readEnvironmentCardSource();
    // The :45-54 block must carry an accessibilityState whose expanded value
    // mirrors the existing useState(false) at :25 — the same value that
    // already drives the numberOfLines ternary at :51.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityState=\{\{\s*expanded:\s*policyExpanded\s*\}\}[\s\S]*?accessibilityLabel=\{`Workspace policy for \$\{environment\.label\}`\}[\s\S]*?\/>/,
    );
  });

  test('the bound-providers PressableScale declares accessibilityState.expanded bound to providersExpanded', () => {
    const src = readEnvironmentCardSource();
    // The :55-66 block must carry an accessibilityState whose expanded value
    // mirrors the existing useState(false) at :26 — the same value that
    // already drives the numberOfLines ternary at :61.
    expect(src).toMatch(
      /<PressableScale[\s\S]*?accessibilityRole="button"[\s\S]*?accessibilityState=\{\{\s*expanded:\s*providersExpanded\s*\}\}[\s\S]*?accessibilityLabel=\{`Bound providers for \$\{environment\.label\}`\}[\s\S]*?\/>/,
    );
  });

  test('the workspace-policy PressableScale keeps accessibilityLabel byte-identical', () => {
    const src = readEnvironmentCardSource();
    // The label is the user-facing sentence the screen reader reads; the new
    // accessibilityState must not change what the button is announced as —
    // only what state it is in. The label is a static string, not a ternary
    // (the clamp is what changes visibly), so the pin is a literal match.
    expect(src).toContain('accessibilityLabel={`Workspace policy for ${environment.label}`}');
  });

  test('the bound-providers PressableScale keeps accessibilityLabel byte-identical', () => {
    const src = readEnvironmentCardSource();
    expect(src).toContain('accessibilityLabel={`Bound providers for ${environment.label}`}');
  });

  test('both PressableScale blocks keep accessibilityRole="button" byte-identical', () => {
    const src = readEnvironmentCardSource();
    // The role is what the screen reader uses to decide the control's verb;
    // accessibilityState supplements the role, it does not replace it.
    const roleCount = (src.match(/accessibilityRole="button"/g) ?? []).length;
    // Three PressableScale blocks in the file: workspace-policy, bound-providers,
    // and the More-actions overflow (line 78-85). All three keep the role.
    expect(roleCount).toBe(3);
  });

  test('the workspace-policy PressableScale keeps setPolicyExpanded((prev) => !prev) byte-identical', () => {
    const src = readEnvironmentCardSource();
    // The handler is what actually flips the state; the new accessibilityState
    // must not change which action fires on tap. The visible expansion is
    // driven by this handler, so accessibilityState.expanded must follow it,
    // not bypass it.
    expect(src).toMatch(/setPolicyExpanded\(\(prev\) => !prev\)/);
  });

  test('the bound-providers PressableScale keeps setProvidersExpanded((prev) => !prev) byte-identical', () => {
    const src = readEnvironmentCardSource();
    expect(src).toMatch(/setProvidersExpanded\(\(prev\) => !prev\)/);
  });

  test('both useState hooks still declare the boolean default false', () => {
    const src = readEnvironmentCardSource();
    // The initial collapse keeps the row slim. The toggle flips it.
    expect(src).toMatch(/const \[policyExpanded, setPolicyExpanded\] = useState\(false\);/);
    expect(src).toMatch(/const \[providersExpanded, setProvidersExpanded\] = useState\(false\);/);
  });

  test('the workspace-policy PressableScale keeps the numberOfLines clamp byte-identical', () => {
    const src = readEnvironmentCardSource();
    // Collapsed keeps numberOfLines 2; expanded passes undefined so the clamp
    // is off entirely. The new accessibilityState must not touch it.
    expect(src).toMatch(
      /numberOfLines=\{policyExpanded \? undefined : 2\}/,
    );
  });

  test('the bound-providers PressableScale keeps the numberOfLines clamp byte-identical', () => {
    const src = readEnvironmentCardSource();
    expect(src).toMatch(
      /numberOfLines=\{providersExpanded \? undefined : 1\}/,
    );
  });

  test('accessibilityState appears on both toggle PressableScale blocks and not on the overflow button', () => {
    const src = readEnvironmentCardSource();
    // Only the workspace-policy and bound-providers PressableScale blocks
    // carry an accessibilityState prop. The More-actions overflow at :78-85
    // is a flat navigation button with no expansion state to announce and
    // must remain accessibilityRole="button" with no accessibilityState.
    // The exclusivity pin guards against a future change that accidentally
    // grows a state prop on the wrong button.
    const workspacePolicyBlock = src.match(
      /onPress=\{\(\) => setPolicyExpanded\([\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(workspacePolicyBlock).toBeDefined();
    expect(workspacePolicyBlock).toMatch(
      /accessibilityState=\{\{\s*expanded:\s*policyExpanded\s*\}\}/,
    );

    const boundProvidersBlock = src.match(
      /onPress=\{\(\) => setProvidersExpanded\([\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(boundProvidersBlock).toBeDefined();
    expect(boundProvidersBlock).toMatch(
      /accessibilityState=\{\{\s*expanded:\s*providersExpanded\s*\}\}/,
    );

    // The More-actions overflow PressableScale (the third <PressableScale> in
    // the file) must not carry accessibilityState.
    const overflowBlock = src.match(
      /onPress=\{\(\) => setActionsVisible\(true\)[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(overflowBlock).toBeDefined();
    expect(overflowBlock).not.toMatch(/accessibilityState=/);
  });

  test('both PressableScale blocks keep hitSlop={CHIP_HIT_SLOP} byte-identical', () => {
    const src = readEnvironmentCardSource();
    // The hitSlop is what makes the press target reachable at the card edge.
    // The new accessibilityState must not move it.
    const hitSlopCount = (src.match(/hitSlop=\{CHIP_HIT_SLOP\}/g) ?? []).length;
    expect(hitSlopCount).toBe(2);
  });

  test('the workspace-policy PressableScale keeps the sandbox/root caption byte-identical', () => {
    const src = readEnvironmentCardSource();
    // The visible caption is what sighted users see inside the press target.
    // The new accessibilityState must not touch it.
    expect(src).toContain(
      '{environment.workspacePolicy.defaultSandbox} · {environment.workspacePolicy.defaultRoot}',
    );
  });

  test('the bound-providers PressableScale keeps the providerRefs caption byte-identical', () => {
    const src = readEnvironmentCardSource();
    // The visible caption is what sighted users see inside the press target,
    // including the "no Gate provider bound" branch.
    expect(src).toContain(
      "environment.providerRefs.length > 0\n            ? `Bound providers: ${environment.providerRefs.join(', ')}`\n            : 'Uses its own credentials — no Gate provider bound.'",
    );
  });
});
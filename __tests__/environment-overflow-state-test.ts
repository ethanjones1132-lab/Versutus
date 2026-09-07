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

// The More-actions overflow (environment-card.tsx:80-87) opens the
// EnvironmentActionsSheet by flipping `actionsVisible` (declared at :24,
// driving `visible={actionsVisible}` at :92, cleared via onClose at :94).
// A sighted operator sees the sheet; a screen-reader user heard only
// "More actions for X" with no announcement that the sheet is open.
describe('environment overflow announces the action sheet state', () => {
  test('the overflow PressableScale declares accessibilityState.expanded bound to actionsVisible', () => {
    const src = readEnvironmentCardSource();
    const overflowBlock = src.match(
      /onPress=\{\(\) => setActionsVisible\(true\)[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(overflowBlock).toBeDefined();
    expect(overflowBlock).toMatch(
      /accessibilityState=\{\{\s*expanded:\s*actionsVisible\s*\}\}/,
    );
  });

  test('the overflow keeps accessibilityLabel byte-identical', () => {
    const src = readEnvironmentCardSource();
    expect(src).toContain('accessibilityLabel={`More actions for ${environment.label}`}');
  });

  test('the overflow keeps onPress setActionsVisible(true) byte-identical', () => {
    const src = readEnvironmentCardSource();
    expect(src).toMatch(/onPress=\{\(\) => setActionsVisible\(true\)\}/);
  });

  test('the overflow keeps accessibilityRole="button"', () => {
    const src = readEnvironmentCardSource();
    const overflowBlock = src.match(
      /onPress=\{\(\) => setActionsVisible\(true\)[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(overflowBlock).toBeDefined();
    expect(overflowBlock).toMatch(/accessibilityRole="button"/);
  });

  test('the sheet still takes visible={actionsVisible} with onClose clearing it', () => {
    const src = readEnvironmentCardSource();
    expect(src).toMatch(/visible=\{actionsVisible\}/);
    expect(src).toMatch(/onClose=\{\(\) => setActionsVisible\(false\)\}/);
  });

  test('the policy/providers expanded toggles are untouched', () => {
    const src = readEnvironmentCardSource();
    expect(src).toMatch(/accessibilityState=\{\{\s*expanded:\s*policyExpanded\s*\}\}/);
    expect(src).toMatch(/accessibilityState=\{\{\s*expanded:\s*providersExpanded\s*\}\}/);
  });

  test('the primary action and desktop-presence note are untouched', () => {
    const src = readEnvironmentCardSource();
    expect(src).toContain('Interactive operations require desktop presence.');
    expect(src).toMatch(/label=\{primary\.label\}/);
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readProviderCardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'provider-card.tsx'].join(SEP),
    'utf8',
  );
}

// The overflow (provider-card.tsx:84-92) opens the ProviderActionsSheet by
// flipping `actionsVisible` (declared at :29, driving
// `visible={actionsVisible}` at :95, cleared via onClose at :97).
// A sighted operator sees the sheet; a screen-reader user heard only
// "More actions for X" with no announcement that the sheet is open.
describe('provider overflow announces the action sheet state', () => {
  test('the overflow PressableScale declares accessibilityState.expanded bound to actionsVisible', () => {
    const src = readProviderCardSource();
    const overflowBlock = src.match(
      /onPress=\{\(\) => setActionsVisible\(true\)[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(overflowBlock).toBeDefined();
    expect(overflowBlock).toMatch(
      /accessibilityState=\{\{\s*expanded:\s*actionsVisible\s*\}\}/,
    );
  });

  test('the overflow keeps accessibilityLabel byte-identical', () => {
    const src = readProviderCardSource();
    expect(src).toContain('accessibilityLabel={`More actions for ${snapshot.label}`}');
  });

  test('the overflow keeps onPress setActionsVisible(true) byte-identical', () => {
    const src = readProviderCardSource();
    expect(src).toMatch(/onPress=\{\(\) => setActionsVisible\(true\)\}/);
  });

  test('the overflow keeps accessibilityRole="button"', () => {
    const src = readProviderCardSource();
    const overflowBlock = src.match(
      /onPress=\{\(\) => setActionsVisible\(true\)[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(overflowBlock).toBeDefined();
    expect(overflowBlock).toMatch(/accessibilityRole="button"/);
  });

  test('the sheet still takes visible={actionsVisible} with onClose clearing it', () => {
    const src = readProviderCardSource();
    expect(src).toMatch(/visible=\{actionsVisible\}/);
    expect(src).toMatch(/onClose=\{\(\) => setActionsVisible\(false\)\}/);
  });

  test('the readiness-toggle expanded state is untouched', () => {
    const src = readProviderCardSource();
    expect(src).toMatch(/accessibilityState=\{\{\s*expanded:\s*readyExpanded\s*\}\}/);
  });

  test('the sheet rows and destructive ConfirmSheet are untouched', () => {
    const src = readProviderCardSource();
    expect(src).toContain('ProviderActionsSheet');
    expect(src).toMatch(/onRename=\{props\.onRename\}/);
  });
});

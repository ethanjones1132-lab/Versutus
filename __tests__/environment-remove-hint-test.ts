declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'environment-actions-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readListRowSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', 'ListRow.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('environment-actions-sheet remove hint', () => {
  test('ListRow declares an optional accessibilityHint prop', () => {
    // The sheet passes `accessibilityHint` on the Remove-environment row; the
    // ListRow prop type must accept it before the call site type-checks.
    const row = readListRowSource();
    expect(row).toMatch(/accessibilityHint\?:/);
    expect(row).toMatch(/export\s+type\s+ListRowProps\s*=\s*\{[\s\S]*?accessibilityHint\?:/);
  });

  test('ListRow forwards accessibilityHint to PressableScale', () => {
    // PressableScale spreads its props onto the inner AnimatedPressable,
    // so the only plumbing ListRow needs is to destructure the hint out
    // of ListRowProps and pass it through. Pin both halves.
    const row = readListRowSource();
    expect(row).toMatch(/accessibilityHint,\n\s+style,\n\s*\}\s*:\s*ListRowProps/);
    expect(row).toMatch(/accessibilityHint=\{accessibilityHint\}/);
  });

  test('the Remove-environment row carries the destructive accessibilityHint', () => {
    // The Remove-environment row is destructive: it arms a ConfirmSheet whose
    // consequence (removal from the Gate) is invisible to a
    // screen-reader user until focus arrives there. The hint names the
    // confirmation and the removal *before* the tap, without
    // restating the row label.
    const src = readSheetSource();
    expect(src).toMatch(
      /accessibilityHint="Opens a confirmation, then removes this environment from the Gate\."/,
    );
    // The hint must live on the Remove-environment row specifically — pin the
    // call-site adjacency on the setRemoveVisible wiring.
    expect(src).toMatch(
      /title="Remove environment"[\s\S]*?onPress=\{\(\) => setRemoveVisible\(true\)\}[\s\S]*?accessibilityHint="Opens a confirmation, then removes this environment from the Gate\./,
    );
  });

  test('the other five rows in the sheet carry no accessibilityHint', () => {
    // Only the destructive row earns a hint. The Check readiness / Start /
    // Stop / Run task / Edit settings rows are reversible or open a
    // follow-up surface, so a hint on any of them would be noise.
    // Exactly one hint in the file.
    const src = readSheetSource();
    expect(src.match(/accessibilityHint=/g)).toHaveLength(1);
  });

  test('the Remove-environment row label and confirm wiring stay byte-identical', () => {
    // A hint addition that nudged the label or rewired the tap would arm a
    // different surface or rename the row. Pin both.
    const src = readSheetSource();
    expect(src).toMatch(/title="Remove environment"/);
    expect(src).toMatch(/onPress=\{\(\) => setRemoveVisible\(true\)\}/);
  });

  test('the ConfirmSheet copy stays byte-identical', () => {
    // The hint names the consequence; the ConfirmSheet confirms it. The
    // sheet copy must not drift to match the hint.
    const src = readSheetSource();
    expect(src).toMatch(/title="Remove environment\?"/);
    expect(src).toMatch(
      /message=\{`\$\{label\} will be removed from this Gate\. Runs already recorded stay in history\.`\}/,
    );
    expect(src).toMatch(/confirmLabel="Remove"/);
    expect(src).toMatch(/\bdanger\b/);
  });
});

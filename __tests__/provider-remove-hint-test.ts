declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'provider-actions-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readListRowSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', 'ListRow.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('provider-actions-sheet remove hint', () => {
  test('ListRow declares an optional accessibilityHint prop', () => {
    // The sheet passes `accessibilityHint` on the Remove-provider row; the
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

  test('the Remove-provider row carries the destructive accessibilityHint', () => {
    // The Remove-provider row is destructive: it arms a ConfirmSheet whose
    // consequence (stored credential removal) is invisible to a
    // screen-reader user until focus arrives there. The hint names the
    // confirmation and the credential removal *before* the tap, without
    // restating the row label.
    const src = readSheetSource();
    expect(src).toMatch(
      /accessibilityHint="Opens a confirmation, then removes this provider and its stored credential from the Gate\."/,
    );
    // The hint must live on the Remove-provider row specifically — pin the
    // call-site adjacency on the confirmDelete wiring.
    expect(src).toMatch(
      /title="Remove provider"[\s\S]*?onPress=\{confirmDelete\}[\s\S]*?accessibilityHint="Opens a confirmation, then removes this provider and its stored credential from the Gate\./,
    );
  });

  test('the other seven rows in the sheet carry no accessibilityHint', () => {
    // Only the destructive row earns a hint. The Rename / Set key /
    // Authorize / Check readiness / Refresh catalog / Disconnect / Disable
    // rows are reversible or open a follow-up surface, so a hint on any of
    // them would be noise. Exactly one hint in the file.
    const src = readSheetSource();
    expect(src.match(/accessibilityHint=/g)).toHaveLength(1);
  });

  test('the Remove-provider row label and confirmDelete wiring stay byte-identical', () => {
    // A hint addition that nudged the label or rewired the tap would arm a
    // different surface or rename the row. Pin both.
    const src = readSheetSource();
    expect(src).toMatch(/title="Remove provider"/);
    expect(src).toMatch(/onPress=\{confirmDelete\}/);
    expect(src).toMatch(/function confirmDelete\(\) \{\n    setDeleteVisible\(true\);\n  \}/);
  });

  test('the ConfirmSheet copy stays byte-identical', () => {
    // The hint names the consequence; the ConfirmSheet confirms it. The
    // sheet copy must not drift to match the hint.
    const src = readSheetSource();
    expect(src).toMatch(/title="Remove provider\?"/);
    expect(src).toMatch(
      /message=\{`\$\{label\} and its stored credential will be removed from the Gate\.`\}/,
    );
    expect(src).toMatch(/confirmLabel="Remove"/);
    expect(src).toMatch(/\bdanger\b/);
  });
});

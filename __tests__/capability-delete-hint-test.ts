declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSectionSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'capabilities-section.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('capabilities-section delete hint', () => {
  test('the Delete instance button carries the destructive accessibilityHint', () => {
    // The Delete button arms a danger ConfirmSheet whose consequence
    // (instance removal from the Gate) is invisible to a screen-reader
    // user until focus arrives there. The hint names the confirmation
    // and the removal *before* the tap, without restating the label.
    const src = readSectionSource();
    expect(src).toMatch(
      /accessibilityHint="Opens a confirmation, then removes this instance from the Gate\."/,
    );
    // The hint must live on the Delete instance button specifically —
    // pin the call-site adjacency on the confirmDelete wiring.
    expect(src).toMatch(
      /label="Delete"[\s\S]*?accessibilityHint="Opens a confirmation, then removes this instance from the Gate\.[\s\S]*?onPress=\{\(\) => confirmDelete\(instance\)\}/,
    );
  });

  test('exactly one accessibilityHint lives in the file', () => {
    // Only the destructive Delete earns a hint. The Add-kind buttons and
    // the draft Save/Cancel are reversible or open a follow-up surface,
    // so a hint on any of them would be noise.
    const src = readSectionSource();
    expect(src.match(/accessibilityHint=/g)).toHaveLength(1);
  });

  test('the Delete label, ghost variant, and confirmDelete wiring stay byte-identical', () => {
    // A hint addition that nudged the label or rewired the tap would arm a
    // different surface or rename the row. Pin both.
    const src = readSectionSource();
    expect(src).toMatch(/label="Delete"/);
    expect(src).toMatch(/variant="ghost"/);
    expect(src).toMatch(/onPress=\{\(\) => confirmDelete\(instance\)\}/);
    expect(src).toMatch(/function confirmDelete\(instance: RegistryInstance\) \{\n    setDeleteCandidate\(instance\);\n  \}/);
  });

  test('the ConfirmSheet copy stays byte-identical', () => {
    // The hint names the consequence; the ConfirmSheet confirms it. The
    // sheet copy must not drift to match the hint.
    const src = readSectionSource();
    expect(src).toMatch(/title="Delete capability\?"/);
    expect(src).toMatch(
      /message=\{\`\$\{deleteCandidate\?\.label \?\? 'This instance'\} \(\$\{deleteCandidate\?\.id \?\? ''\}\) will be removed from the Gate\.\`?\}/,
    );
    expect(src).toMatch(/confirmLabel="Delete"/);
    expect(src).toMatch(/\n\s+danger\n/);
  });
});

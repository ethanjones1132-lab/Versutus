declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readListSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'compact-gateway-list.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readSectionSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'gateway-management-section.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('saved-gateway remove hint', () => {
  test('the Remove button carries the destructive accessibilityHint', () => {
    // The Remove button arms a danger ConfirmSheet that deletes the saved
    // gateway profile. A screen-reader user hears only "Remove" with no
    // warning until the sheet arrives; the hint names the consequence
    // before the tap, mirroring the cron Remove hint shape.
    const src = readListSource();
    expect(src).toMatch(
      /accessibilityHint="Opens a confirmation, then removes this saved gateway from the app\."/,
    );
    expect(src).toMatch(
      /label="Remove"[\s\S]*?accessibilityHint="Opens a confirmation, then removes this saved gateway from the app\./,
    );
  });

  test('exactly one accessibilityHint lives in the row file', () => {
    // The hint belongs on the destructive Remove only. A second hint on
    // the Connect/Reconnect button or the URL toggle would be noise.
    const src = readListSource();
    const hits = src.match(/accessibilityHint/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  test('the Remove Button label, variant, and onDelete wiring stay byte-identical', () => {
    // The hint addition must not nudge what the button says, how it
    // looks, or what it calls.
    const src = readListSource();
    const removeBlock = src.match(/<Button\s+label="Remove"[\s\S]*?\/>/)?.[0];
    expect(removeBlock).toBeDefined();
    expect(removeBlock!).toMatch(/label="Remove"/);
    expect(removeBlock!).toMatch(/onPress=\{onDelete\}/);
    expect(removeBlock!).toMatch(/variant="ghost"/);
  });

  test('the Connect/Reconnect button never carries accessibilityHint', () => {
    // Pure navigation into handleConnect — reversible and stateless,
    // correctly hint-free.
    const src = readListSource();
    const connectBlock = src.match(
      /<Button\s+label=\{isActive \? 'Reconnect' : 'Connect'\}[\s\S]*?\/>/,
    )?.[0];
    expect(connectBlock).toBeDefined();
    expect(connectBlock!).not.toMatch(/accessibilityHint/);
  });

  test('the destructive ConfirmSheet stays byte-identical', () => {
    // The on-tap wording already names the consequence for sighted
    // users. The hint is for before the tap; the sheet must not change.
    const src = readSectionSource();
    expect(src).toMatch(/title="Remove gateway\?"/);
    expect(src).toMatch(
      /message=\{`\$\{deleteCandidate\?\.name \?\? 'This gateway'\} will stay available if discovered again\.`\}/,
    );
    expect(src).toMatch(/confirmLabel="Remove"/);
    expect(src).toMatch(/danger\s*\n\s*onCancel=/);
  });

  test('both CompactGatewayList call sites stay untouched', () => {
    // The list renders once in the management section; its onSelect and
    // onDelete props wire handleConnect and handleDelete. Pin both so a
    // hint-adjacent edit cannot rewire the row.
    const src = readSectionSource();
    expect(src).toMatch(/<CompactGatewayList/);
    expect(src).toMatch(/onSelect=\{\(gateway\) => void handleConnect\(gateway\.id\)\}/);
    expect(src).toMatch(/onDelete=\{\(gateway\) => handleDelete\(gateway\.id\)\}/);
  });
});

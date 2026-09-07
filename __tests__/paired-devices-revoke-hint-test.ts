declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readPaneSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'paired-devices-pane.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readButtonSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', 'Button.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readButtonTypesSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', 'types.ts'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('paired-devices revoke hint', () => {
  test('the kit Button type declares an optional accessibilityHint prop', () => {
    // The pane passes `accessibilityHint` on the Revoke button; the kit
    // Button's prop type must accept it before the call site type-checks.
    // Reading types.ts directly avoids relying on the (working) TS
    // build: a future regression that drops the prop field would surface
    // here before reaching the runtime.
    const types = readButtonTypesSource();
    expect(types).toMatch(/accessibilityHint\?:/);
    // The prop lives on ButtonProps, not a stray import.
    expect(types).toMatch(/export\s+type\s+ButtonProps\s*=\s*\{[\s\S]*?accessibilityHint\?:/);
  });

  test('the kit Button forwards accessibilityHint to PressableScale', () => {
    // PressableScale already spreads PressableProps onto its inner
    // Pressable, so the only plumbing the kit needs is to destructure
    // accessibilityHint out of ButtonProps and pass it through. A
    // regression that destructures but forgets to forward would silently
    // drop the hint for every caller — pin both halves.
    const button = readButtonSource();
    expect(button).toMatch(/accessibilityHint,\n\s+expanded,\n(?:\s+busy,\n)?(?:\s+selected,\n)?\s*\}\s*:\s*ButtonProps/);
    expect(button).toMatch(/accessibilityHint=\{accessibilityHint\}/);
  });

  test('the Revoke button carries the destructive accessibilityHint', () => {
    // The Revoke button is destructive: it opens a ConfirmSheet whose
    // consequence ("token removed from the Gate") is invisible to a
    // screen-reader user until focus arrives there. The hint names the
    // consequence *before* the tap, paired with the same wording the
    // visible ConfirmSheet message uses ("token will be removed from the
    // Gate"). The wording is intentionally close to the ConfirmSheet
    // message at paired-devices-pane.tsx:125 — the hint says what
    // happens, the ConfirmSheet confirms it on tap.
    const src = readPaneSource();
    expect(src).toMatch(
      /accessibilityHint="Opens a confirmation, then removes this device's token from the Gate\. Other paired devices keep working\."/,
    );
    // The hint must live on the Revoke button block specifically — not
    // on the Retry button or the row. Pin the call-site adjacency.
    expect(src).toMatch(
      /label="Revoke"[\s\S]*?accessibilityHint="Opens a confirmation, then removes this device's token from the Gate\./,
    );
  });

  test('the failed-first-read Retry button never carries accessibilityHint', () => {
    // Retry is reversible: it re-runs the existing device.list read the
    // mount effect runs. A hint on it would be noise ("Opens the same
    // read again") and would mislead a screen-reader user into
    // expecting consequence where there is none. Pin its absence so a
    // future "hint on every ghost button" regression fails loudly.
    const src = readPaneSource();
    // The Retry Button block stays exactly as iter-113 left it.
    expect(src).toMatch(/label="Retry"[\s\S]*?onPress=\{\(\) => void load\(\)\}/);
    // The Retry block does NOT mention accessibilityHint.
    const retryBlock = src.match(/<Button\s+label="Retry"[\s\S]*?\/>/)?.[0];
    expect(retryBlock).toBeDefined();
    expect(retryBlock!).not.toMatch(/accessibilityHint/);
  });

  test('the !row.revoked branch gate stays byte-identical', () => {
    // The Revoke button still lives inside the !row.revoked ternary
    // from iter-113 — a hint addition that nudged the gate would render
    // a destructive button on a device the Gate already revoked.
    const src = readPaneSource();
    expect(src).toMatch(/!\s*row\.revoked\s*\?/);
    expect(src).toMatch(
      /!\s*row\.revoked\s*\?\s*\([\s\S]*?Revoke[\s\S]*?\)\s*:\s*null/,
    );
    // The active/revoked badges are untouched — they are still the only
    // visual signal of state.
    expect(src).toMatch(/Badge label="active"/);
    expect(src).toMatch(/Badge label="revoked"/);
  });

  test('the destructive ConfirmSheet stays byte-identical', () => {
    // The on-tap wording already names the consequence for sighted
    // users. The hint is for screen-reader users *before* the tap; the
    // ConfirmSheet itself must not change wording, copy, or semantics.
    const src = readPaneSource();
    expect(src).toMatch(/title="Revoke device\?"/);
    expect(src).toMatch(
      /message="This device's token will be removed from the Gate\. Any other paired device keeps working\."/,
    );
    expect(src).toMatch(/confirmLabel="Revoke"/);
    expect(src).toMatch(/danger\s*\n\s*onCancel=/);
  });
});
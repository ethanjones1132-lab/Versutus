declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readViewSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('group-room disband hint', () => {
  test('the Disband pill carries the destructive accessibilityHint', () => {
    // The Disband pill arms an irreversible roster+transcript removal via
    // setDisbandVisible(true) -> ConfirmSheet. The hint names the
    // consequence *before* the tap, using the same "Opens a
    // confirmation, then ..." shape as the Delete-session / Remove-cron
    // / Revoke-device precedents.
    const src = readViewSource();
    expect(src).toMatch(
      /accessibilityHint="Opens a confirmation, then removes this room from the roster and deletes its transcript\. This cannot be undone\."/,
    );
    // The hint lives on the Disband pill block specifically — pin the
    // call-site adjacency from setDisbandVisible to the hint.
    expect(src).toMatch(
      /onPress=\{\(\) => setDisbandVisible\(true\)\}[\s\S]*?accessibilityHint="Opens a confirmation, then removes this room from the roster and deletes its transcript\./,
    );
  });

  test('the Disband label and role stay byte-identical', () => {
    // The hint is a second signal, not a replacement: the label still
    // reads "Disband room" and the role is still button.
    const src = readViewSource();
    const disbandBlock = src.match(
      /onPress=\{\(\) => setDisbandVisible\(true\)\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(disbandBlock).toBeDefined();
    expect(disbandBlock!).toMatch(/accessibilityRole="button"/);
    expect(disbandBlock!).toMatch(/accessibilityLabel="Disband room"/);
  });

  test('the Disband ConfirmSheet copy stays byte-identical', () => {
    // The confirmation the hint names is unchanged.
    const src = readViewSource();
    expect(src).toMatch(/title="Disband room"/);
    expect(src).toMatch(
      /leaves the roster and its transcript is deleted from the Gate\. This cannot be undone\./,
    );
    expect(src).toMatch(/confirmLabel=\{disbanding \? 'Disbanding…' : 'Disband'\}/);
  });

  test('no other pill or chip in the file carries accessibilityHint', () => {
    // Rename/Add pills open non-destructive sheets and member chips
    // already announce their own remove/disabled state — a hint on any
    // of them would be noise.
    const src = readViewSource();
    expect(src.match(/accessibilityHint=/g)).toHaveLength(1);
  });
});

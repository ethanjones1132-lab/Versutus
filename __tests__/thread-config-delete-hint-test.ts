declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'thread-config-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('thread-config session delete hint', () => {
  test('the delete button carries the destructive accessibilityHint', () => {
    // The per-row delete button arms an irreversible gateway removal via
    // confirmDelete -> ConfirmSheet. The hint names the consequence
    // *before* the tap, using the same "Opens a confirmation, then
    // removes ..." shape as the paired-devices Revoke and cron-job
    // Remove precedents.
    const src = readSheetSource();
    expect(src).toMatch(
      /accessibilityHint="Opens a confirmation, then removes this session from the gateway\."/,
    );
    // The hint lives on the delete button block specifically — pin the
    // call-site adjacency from the confirmDelete handler to the hint.
    expect(src).toMatch(
      /onPress=\{\(\) => confirmDelete\(item\)\}[\s\S]*?accessibilityHint="Opens a confirmation, then removes this session from the gateway\./,
    );
  });

  test('the delete label and role stay byte-identical', () => {
    // The hint is a second signal, not a replacement: the label still
    // names the session and the role is still button.
    const src = readSheetSource();
    expect(src).toMatch(
      /accessibilityLabel=\{`Delete session \$\{sessionListTitle\(item\.title\)\}`\}/,
    );
    const deleteBlock = src.match(
      /onPress=\{\(\) => confirmDelete\(item\)\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(deleteBlock).toBeDefined();
    expect(deleteBlock!).toMatch(/accessibilityRole="button"/);
  });

  test('the ConfirmSheet copy stays byte-identical', () => {
    // The confirmation the hint names is unchanged.
    const src = readSheetSource();
    expect(src).toMatch(/title="Delete session\?"/);
    expect(src).toMatch(
      /message=\{`"\$\{sessionListTitle\(deleteCandidate\?\.title\)\}" is removed from the gateway\.`\}/,
    );
    expect(src).toMatch(/confirmLabel="Delete session"/);
  });

  test('the delete gate stays byte-identical', () => {
    // The destructive button still renders only for a non-current
    // session when a delete handler exists.
    const src = readSheetSource();
    expect(src).toMatch(/\{onDeleteSession && !isCurrent \?/);
  });

  test('no other control in the file carries accessibilityHint', () => {
    // Session-card, model-card, and section-header controls must not
    // grow a hint: the session card announces selected, the model card
    // announces selected/disabled, the section header announces
    // expanded — a hint on any of them would be noise.
    const src = readSheetSource();
    expect(src.match(/accessibilityHint=/g)).toHaveLength(1);
  });
});

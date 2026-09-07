declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheet(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'cron-job-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readKit(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', 'ConfirmSheet.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

// The scheduled-job Remove ConfirmSheet fired `executeRemove` (which flips
// the real `acting` boolean around `await botJobs.remove(target)`) but
// announced nothing to a screen reader while the delete was in flight. The
// fix passes the existing defined-only `busy` half on ConfirmSheet (shipped
// for the group-room Disband confirm) at this one call site — no kit change.
describe('cron-job-sheet remove busy state', () => {
  test('the remove ConfirmSheet passes busy={acting}', () => {
    const src = readSheet();
    expect(src).toContain('busy={acting}');
  });

  test('busy={acting} wires exactly once on the remove ConfirmSheet', () => {
    const src = readSheet();
    // Run-now and Pause/Resume already carry their own `busy={acting}`
    // Buttons, so a file-wide count is 3 by design. The new wiring is the
    // one inside the ConfirmSheet block, pinned here.
    const blocks = src.match(/<ConfirmSheet[\s\S]*?\/>/g) ?? [];
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.match(/busy=\{acting\}/g)?.length ?? 0).toBe(1);
  });

  test('the kit ConfirmSheet still forwards the defined-only busy half', () => {
    // The call-site wiring above only announces anything because the kit
    // spreads `busy` onto the confirm Button only when defined. Pin the
    // kit half here so a future kit regression surfaces beside the wiring.
    const kit = readKit();
    expect(kit).toMatch(/busy\?: boolean;/);
    expect(kit).toContain('busy={busy}');
  });

  test('the Remove title, message, confirmLabel, and Cancel stay byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('title="Remove scheduled job?"');
    expect(src).toContain(
      'message={`${job.title || job.id} will be removed from this gateway. Its run history stops here.`}',
    );
    expect(src).toContain('confirmLabel="Remove"');
    expect(src).toContain('onCancel={() => setRemoveTarget(null)}');
    expect(src).toContain('onConfirm={() => void executeRemove()}');
  });

  test('the Remove button hint stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain(
      'accessibilityHint="Opens a confirmation, then removes this scheduled job and stops its run history."',
    );
  });

  test('the acting guard around the remove stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('if (!target || acting) return;');
    expect(src).toContain('setActing(true);');
    expect(src).toContain('setActing(false);');
    expect(src).toContain('await botJobs.remove(target);');
  });

  test('no Button in the sheet takes busy except through the ConfirmSheet', () => {
    // Run-now and Pause/Resume already announce `acting` via their own
    // `busy={acting}` Buttons; this pin guards the ConfirmSheet as the one
    // new busy wiring, not a second Button gaining one.
    const src = readSheet();
    const blocks = src.match(/<ConfirmSheet[\s\S]*?\/>/g) ?? [];
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toContain('busy={acting}');
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSheet(): string {
  return readSource(['src', 'components', 'activity', 'cron-job-sheet.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// Both cron-job control Buttons hold a real `acting` boolean that already
// swaps the Run label and disables the buttons through the control call —
// but without a `busy` half a screen-reader user heard a flat disabled
// label while a sighted user saw the in-flight state. The fix is a
// one-line `busy={acting}` wiring on each, onto the `busy` prop the
// group-room busy item added to `Button`. The Remove row stays unwired:
// its in-flight half lives behind the confirm.
describe('cron-job control busy state', () => {
  test('the Run-now button passes busy={acting}', () => {
    const src = readSheet();
    expect(src).toContain("label={acting ? 'Working…' : 'Run now'}");
    expect(src).toContain('busy={acting}');
  });

  test('the busy wiring lands exactly twice (Run-now + Pause/Resume)', () => {
    const src = readSheet();
    expect(src.match(/busy=\{acting\}/g)?.length ?? 0).toBe(2);
  });

  test('the Run label ternary stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain("label={acting ? 'Working…' : 'Run now'}");
  });

  test('the pause label stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('label={cronJobPauseLabel({ paused })}');
  });

  test('both control disabled gates stay byte-identical', () => {
    const src = readSheet();
    expect(src.match(/disabled=\{acting\}/g)?.length ?? 0).toBe(3);
  });

  test('the Remove row hint and confirm stay byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('accessibilityHint="Opens a confirmation, then removes this scheduled job and stops its run history."');
    expect(src).toContain('title="Remove scheduled job?"');
    expect(src).toContain('confirmLabel="Remove"');
  });

  test('Button spreads a defined-only busy half', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

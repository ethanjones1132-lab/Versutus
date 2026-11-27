declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readConfirmSheet(): string {
  return readSource(['src', 'components', 'ui', 'ConfirmSheet.tsx']);
}

// A danger confirm painted its confirm action with the brand `primary`
// variant, so Remove/Disconnect/Delete read like a normal forward action. It
// now uses the same red `destructive` Button that Deny uses in
// approval-decision-card.tsx; only a non-danger confirm stays secondary.
describe('a danger ConfirmSheet looks destructive', () => {
  test('the confirm Button maps danger onto the destructive variant', () => {
    const src = readConfirmSheet();
    expect(src).toContain("variant={danger ? 'destructive' : 'secondary'}");
    // The old mapping is what made Remove/Disconnect look like a forward
    // action; it must not come back.
    expect(src).not.toContain("variant={danger ? 'primary'");
  });

  test('non-danger still falls through to secondary', () => {
    const src = readConfirmSheet();
    expect(src).toContain(": 'secondary'}");
    // Exactly one variant decision on the confirm Button.
    expect(src.match(/danger \?/g)?.length ?? 0).toBe(1);
  });

  test('destructive is the same variant Button paints red for Deny', () => {
    const deny = readSource(['src', 'components', 'activity', 'approval-decision-card.tsx']);
    expect(deny).toMatch(/label="Deny"\s+variant="destructive"/);
    // The red comes from one place: Button's destructive branch.
    const button = readSource(['src', 'components', 'ui', 'Button.tsx']);
    expect(button).toContain("variant === 'destructive'");
    expect(button).toContain('backgroundColor: tokens.statusDisconnected');
  });

  test('every danger caller arms a danger sheet, so all render destructive', () => {
    const callers = [
      ['src', 'components', 'activity', 'cron-job-sheet.tsx'],
      ['src', 'components', 'chat', 'chat-overflow-sheet.tsx'],
    ];
    for (const rel of callers) {
      const src = readSource(rel);
      const start = src.indexOf('<ConfirmSheet');
      expect(start).toBeGreaterThan(-1);
      const block = src.slice(start, src.indexOf('/>', start) + 2);
      // `danger` alone on its own line — the prop, not prose in the message.
      expect(block).toMatch(/\n\s+danger\n/);
    }
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readNewAgentSheet(): string {
  return readSource(['src', 'components', 'chat', 'new-agent-sheet.tsx']);
}

function readCreateGroupSheet(): string {
  return readSource(['src', 'components', 'chat', 'create-group-sheet.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// Both sheet Create buttons hold a real `busy` boolean that already swaps
// the label and disables the button — but without a `busy` half a
// screen-reader user heard the swapped label with no busy state while a
// sighted user saw the in-flight label. The fix is a one-line
// `busy={busy}` wiring on each, onto the `busy` prop the group-room busy
// item added to `Button`.
describe('sheet create busy state', () => {
  test('the New-agent Create button passes busy={busy}', () => {
    const src = readNewAgentSheet();
    expect(src).toContain('busy={busy}');
  });

  test('the New-agent busy wiring lands exactly once', () => {
    const src = readNewAgentSheet();
    expect(src.match(/busy=\{busy\}/g)?.length ?? 0).toBe(1);
  });

  test('the New-agent create/save label ternary stays byte-identical', () => {
    const src = readNewAgentSheet();
    expect(src).toContain("label={busy ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save' : 'Create'}");
  });

  test('the New-agent disabled gate stays byte-identical', () => {
    const src = readNewAgentSheet();
    expect(src).toContain('disabled={busy || !name.trim()}');
  });

  test('the New-agent inheritKeys toggle stays byte-identical', () => {
    const src = readNewAgentSheet();
    expect(src).toContain("label={inheritKeys ? 'Inherit keys from default' : 'Empty key set'}");
  });

  test('the group Create-room button passes busy={busy}', () => {
    const src = readCreateGroupSheet();
    expect(src).toContain('busy={busy}');
  });

  test('the group busy wiring lands exactly once', () => {
    const src = readCreateGroupSheet();
    expect(src.match(/busy=\{busy\}/g)?.length ?? 0).toBe(1);
  });

  test('the group create label ternary stays byte-identical', () => {
    const src = readCreateGroupSheet();
    expect(src).toContain("label={busy ? 'Creating…' : 'Create room'}");
  });

  test('the group disabled gate stays byte-identical', () => {
    const src = readCreateGroupSheet();
    expect(src).toContain('disabled={busy || !validation.ok}');
  });

  test('the group member Chip selected wiring stays byte-identical', () => {
    const src = readCreateGroupSheet();
    expect(src).toContain('selected={memberIds.includes(bot.id)}');
  });

  test('Button still spreads busy only when defined', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

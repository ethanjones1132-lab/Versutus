declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readCard(): string {
  return readSource(['src', 'components', 'activity', 'approval-decision-card.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// Both approval Buttons hold a real `busy` boolean (exit !== 'idle')
// that already disables the buttons through the exit animation — but
// without a `busy` half a screen-reader user heard a flat disabled
// label while a sighted user saw the card fold away. The fix is a
// one-line `busy={busy}` wiring on each, onto the `busy` prop the
// group-room busy item added to `Button`.
describe('approval decision busy state', () => {
  test('the Approve button passes busy={busy}', () => {
    const src = readCard();
    expect(src).toContain('label="Approve" onPress={() => decide(true)} disabled={busy} busy={busy}');
  });

  test('the Deny button passes busy={busy}', () => {
    const src = readCard();
    expect(src).toContain('label="Deny"');
    expect(src.match(/busy=\{busy\}/g)?.length ?? 0).toBe(2);
  });

  test('the busy wiring lands exactly twice (Approve + Deny)', () => {
    const src = readCard();
    expect(src.match(/busy=\{busy\}/g)?.length ?? 0).toBe(2);
  });

  test('both labels stay byte-identical', () => {
    const src = readCard();
    expect(src).toContain('label="Approve"');
    expect(src).toContain('label="Deny"');
  });

  test('both disabled gates stay byte-identical', () => {
    const src = readCard();
    expect(src.match(/disabled=\{busy\}/g)?.length ?? 0).toBe(2);
  });

  test('the prompt expanded toggle stays byte-identical', () => {
    const src = readCard();
    expect(src).toContain("accessibilityLabel={promptExpanded ? 'Collapse run prompt' : 'Expand run prompt'}");
  });

  test('the busy derivation stays byte-identical', () => {
    const src = readCard();
    expect(src).toContain("const busy = exit !== 'idle'");
  });

  test('Button still spreads busy only when defined', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

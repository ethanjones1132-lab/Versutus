declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSection(): string {
  return readSource(['src', 'components', 'activity', 'cron-section.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// The cron New-scheduled-job Add Button holds a real `creating` boolean
// that already swaps the label and disables the button while the create
// is in flight — but without a `busy` half a screen-reader user heard a
// flat disabled label while a sighted user saw Adding…. The fix is a
// one-line `busy={creating}` wiring onto the `busy` prop Button spreads
// defined-only into accessibilityState.
describe('cron section add busy state', () => {
  test('the Add button passes busy={creating}', () => {
    const src = readSection();
    expect(src).toContain('busy={creating}');
  });

  test('the busy wiring lands exactly once', () => {
    const src = readSection();
    expect(src.match(/busy=\{creating\}/g)?.length ?? 0).toBe(1);
  });

  test('the label ternary stays byte-identical', () => {
    const src = readSection();
    expect(src).toContain("label={creating ? 'Adding…' : 'Add'}");
  });

  test('the disabled gate stays byte-identical', () => {
    const src = readSection();
    expect(src).toContain('disabled={creating || !canCreateGatewayJob({ title, prompt, schedule })}');
  });

  test('the creating state still wraps the create', () => {
    const src = readSection();
    expect(src).toContain('setCreating(true)');
    expect(src).toContain('.finally(() => setCreating(false))');
  });

  test('submitCreate keeps its re-entry guard', () => {
    const src = readSection();
    expect(src).toContain('if (!submitted.title || !submitted.prompt || creating) return;');
  });

  test('Button spreads a defined-only busy half', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

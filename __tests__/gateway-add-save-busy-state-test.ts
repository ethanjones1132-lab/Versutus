declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readScreen(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'app', 'gateway', 'add.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readButton(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'ui', 'Button.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// The manual-add-gateway Save & connect Button (add.tsx:194-198) holds a real
// `saving` boolean that gates the press via `disabled={saving ||
// !url.trim()}` through a save spanning a manifest probe plus a connect —
// but without a `busy` half a screen-reader user heard a flat disabled label
// while a sighted user saw the dimmed (opacity 0.5) in-flight state. The fix
// is a one-line `busy={saving}` wiring onto the `busy` prop Button already
// spreads as a defined-only accessibilityState half.
describe('manual-add-gateway Save & connect busy state', () => {
  test('the Save & connect Button passes busy={saving}', () => {
    const src = readScreen();
    const block = src.match(/<Button[\s\S]*?\/>/)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('label="Save & connect"');
    expect(block).toContain('busy={saving}');
  });

  test('the busy wiring lands exactly once', () => {
    const src = readScreen();
    expect(src.match(/busy=\{saving\}/g)?.length ?? 0).toBe(1);
  });

  test('the label stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('label="Save & connect"');
  });

  test('the disabled gate stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('disabled={saving || !url.trim()}');
  });

  test('the handleSave flow stays byte-identical', () => {
    const src = readScreen();
    expect(src).toContain('setSaving(true)');
    expect(src).toContain('onPress={() => void handleSave()}');
    expect(src).toContain("router.replace('/chat')");
  });

  test('the TransportSecurityCard and error branches stay byte-identical', () => {
    const src = readScreen();
    expect(src).toContain(
      '{url.trim() ? <TransportSecurityCard url={url} /> : null}',
    );
    expect(src).toContain('onRetry={() => void handleSave()}');
  });

  test('Button spreads a defined-only busy half', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});

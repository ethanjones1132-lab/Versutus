declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSettings(): string {
  return readSource(['src', 'app', 'gateway', 'settings.tsx']);
}

// After pairing is dismissed, gateway settings is the remaining place the
// device id is shown, and it rendered the id as plain text with no way to get
// it off the screen. PairingPanel already copies the same id through
// DeviceIdRow — render that same row here.
describe('gateway settings offers Copy for the device id', () => {
  test('the device id renders through DeviceIdRow wired to a copy handler', () => {
    const src = readSettings();
    expect(src).toContain("import { DeviceIdRow } from '@/components/device-id-row';");
    expect(src).toContain('<DeviceIdRow deviceId={deviceId} copied={copied} onCopy={copyText} />');
  });

  test('the copy handler writes the id to the clipboard and marks it copied', () => {
    const src = readSettings();
    const copyAt = src.indexOf('const copyText = useCallback(');
    expect(copyAt).toBeGreaterThanOrEqual(0);
    const copyFn = src.slice(copyAt, copyAt + 500);
    expect(copyFn).toContain('Clipboard.setStringAsync(text)');
    expect(copyFn).toContain("setCopied('id')");
    expect(copyFn).toContain('setTimeout(() => setCopied(null), 2000)');
  });

  test('the id is no longer rendered as plain mono text', () => {
    const src = readSettings();
    expect(src).not.toContain(
      '<Text variant="mono" color="secondary">\n                  {deviceId}\n                </Text>',
    );
  });

  test('the loading fallback copy stays byte-identical', () => {
    const src = readSettings();
    expect(src).toContain('Loading device identity…');
  });

  test('the private-key micro copy stays byte-identical', () => {
    const src = readSettings();
    expect(src).toContain(
      'Used for gateway pairing and access requests. The private key remains in secure storage.',
    );
  });

  test('the private key itself is never rendered', () => {
    const src = readSettings();
    expect(src).not.toContain('{privateKey}');
    expect(src).not.toContain('settings.privateKey');
  });

  test('PairingPanel DeviceIdRow usage stays byte-identical', () => {
    const src = readSource(['src', 'components', 'pairing-panel.tsx']);
    expect(src).toContain('<DeviceIdRow deviceId={deviceId} copied={copied} onCopy={copyText} />');
  });
});

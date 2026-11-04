declare const __dirname: string;
const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const SEP = __dirname.includes('\\') ? '\\' : '/';

describe('pairing approval command safety', () => {
  const src = fs.readFileSync([__dirname, '..', 'src', 'components', 'pairing-panel.tsx'].join(SEP), 'utf8');

  it('accepts only safe request ids and otherwise uses the established placeholder', () => {
    expect(src).toContain("/^[A-Za-z0-9_-]+$/.test(pairingDetails.requestId)");
    expect(src).toContain('`openclaw devices approve ${pairingDetails.requestId}`');
    expect(src).toContain("'openclaw devices approve <requestId>'");
    expect(src).toContain('Use the request id shown by the list command.');
  });

  it('keeps the other pairing copy rows', () => {
    expect(src).toContain('openclaw devices list');
    expect(src).toContain('<DeviceIdRow deviceId={deviceId} copied={copied} onCopy={copyText} />');
  });
});

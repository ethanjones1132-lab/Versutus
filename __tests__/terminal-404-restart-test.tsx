declare const __dirname: string;
const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const SEP = __dirname.includes('\\') ? '\\' : '/';

describe('terminal 404 restart lifecycle', () => {
  const src = fs.readFileSync([__dirname, '..', 'src', 'components', 'terminal', 'terminal-screen.tsx'].join(SEP), 'utf8');

  it('releases only a missing session so the start effect can reopen it', () => {
    expect(src).toMatch(/if \(message\.includes\('404'\)\) \{\s*sessionRef\.current = null;\s*setTerminalConnected\(false\);/);
    expect(src).toContain('&& !sessionRef.current');
  });

  it('preserves the typed input, visible error, and non-404 live session', () => {
    expect(src).toContain('setInput(value);');
    expect(src).toContain('setTerminalError(message);');
    expect(src).toContain('Any other failure (network blip, 500) leaves the session alive.');
    expect(src).toContain('sessionRef.current?.close();');
  });
});

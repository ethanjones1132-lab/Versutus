declare const __dirname: string;
const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const SEP = __dirname.includes('\\') ? '\\' : '/';

describe('/session new title parsing', () => {
  const src = fs.readFileSync([__dirname, '..', 'src', 'lib', 'gateway', 'slash-commands.ts'].join(SEP), 'utf8');

  it('uses the raw remainder after /session new, with the optional no-title path', () => {
    expect(src).toMatch(/runSessionCommand\(args, context, trimmed\)/);
    expect(src).toContain("const title = rawInput?.replace(/^\\/session\\s+new\\b/i, '').trim() || undefined;");
    expect(src).toContain('context.createNewSession(title)');
    expect(src).toContain("'New session opened — the thread starts fresh'");
  });
});

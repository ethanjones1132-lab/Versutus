declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(relative: string): string {
  // The touched .tsx sources are CRLF on disk; normalize so the block
  // regexes below do not depend on the file's line endings.
  return nodeFs
    .readFileSync([__dirname, '..', 'src', ...relative.split('/')].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('RPC inline text result preview', () => {
  test('the shared text branch clamps to a named preview line count', () => {
    const source = readSource('components/terminal/command-result-view.tsx');
    // The inline card and the sheet share CommandResultView; the clamp is a
    // prop that defaults off, so only the inline usage bounds long text.
    expect(source).toMatch(/const RPC_RESULT_PREVIEW_LINES = 8;/);
    expect(source).toMatch(
      /numberOfLines=\{preview \? RPC_RESULT_PREVIEW_LINES : undefined\}/,
    );
    expect(source).toMatch(/preview = false \}: \{ log: string; preview\?: boolean \}\)/);
  });

  test('the inline usage opts into the preview while the sheet keeps the full render', () => {
    const screen = readSource('components/terminal/terminal-screen.tsx');
    expect(screen).toMatch(/<CommandResultView log=\{item\} preview \/>/);
    // The existing "Raw" / Open full output affordance stays wired beside the
    // preview card so the full read lives in the sheet.
    expect(screen).toMatch(/onOpenOutput=\{\(\) => setLogSheetVisible\(true\)\}/);

    const sheet = readSource('components/terminal/command-log-sheet.tsx');
    expect(sheet.match(/<CommandResultView log=\{log\} \/>/g)?.length ?? 0).toBe(2);
    expect(sheet).not.toMatch(/preview/);
  });
});
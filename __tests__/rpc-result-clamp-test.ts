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
  test('the shared text branch bounds the preview in a capped, scrollable teaser', () => {
    const source = readSource('components/terminal/command-result-view.tsx');
    // The inline card and the sheet share CommandResultView; the inline (preview)
    // path caps a long dump in a bounded ScrollView so the tail is scrollable
    // instead of clipped at a line count, while the sheet path renders the full,
    // unscoped text.
    expect(source).toMatch(/const RPC_RESULT_PREVIEW_MAX_HEIGHT = \d+;/);
    expect(source).toMatch(/previewScroll: \{[\s\S]*?maxHeight: RPC_RESULT_PREVIEW_MAX_HEIGHT/);
    expect(source).toMatch(/<ScrollView style=\{styles\.previewScroll\} nestedScrollEnabled>/);
    // The bare 8-line clamp is gone -- the rest of the dump is reachable on the
    // phone, not silently truncated.
    expect(source).not.toMatch(/RPC_RESULT_PREVIEW_LINES/);
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
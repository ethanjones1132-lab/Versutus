declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSheet(): string {
  return readSource(['src', 'components', 'activity', 'cron-job-sheet.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// The scheduled-job sheet's Show prompt / Show raw record Buttons flip real
// `showPrompt` / `showRaw` booleans driving `{show ? … : null}` content, but
// announced only the swapped label — so a screen-reader user heard no
// open/closed state while a sighted user saw the prompt/raw card appear.
// The fix passes `expanded={showPrompt}` / `expanded={showRaw}` on the two
// toggles only, matching the four BotChrome toggles.
describe('cron job sheet toggles expanded state', () => {
  test('prompt toggle passes expanded={showPrompt}', () => {
    expect(readSheet()).toContain('expanded={showPrompt}');
  });

  test('raw toggle passes expanded={showRaw}', () => {
    expect(readSheet()).toContain('expanded={showRaw}');
  });

  test('expanded is wired exactly twice — on the two toggles, nothing else', () => {
    const src = readSheet();
    const hits = src.match(/expanded=\{/g) ?? [];
    expect(hits).toHaveLength(2);
  });

  test('prompt toggle label is byte-identical', () => {
    expect(readSheet()).toContain(
      "label={showPrompt ? 'Hide prompt' : `Show prompt (${job.promptLength ?? 0} chars)`}",
    );
  });

  test('raw toggle label is byte-identical', () => {
    expect(readSheet()).toContain("label={showRaw ? 'Hide raw record' : 'Show raw record'}");
  });

  test('both gated content branches are untouched', () => {
    const src = readSheet();
    expect(src).toContain('{showPrompt ? (');
    expect(src).toContain('{showRaw ? (');
  });

  test('Button spreads expanded into accessibilityState only when defined', () => {
    expect(readButton()).toContain('...(expanded !== undefined ? { expanded } : null)');
  });

  test('Copy job id button carries no expanded', () => {
    const src = readSheet();
    const copyIdx = src.indexOf('label="Copy job id"');
    expect(copyIdx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, copyIdx - 200), copyIdx);
    expect(window).not.toContain('expanded=');
  });

  test('run-history Retry button carries no expanded', () => {
    const src = readSheet();
    expect(src).toContain('<Button label="Retry" variant="ghost" size="sm" onPress={() => void loadRuns()} />');
  });
});

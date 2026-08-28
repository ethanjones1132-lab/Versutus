declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const file = [__dirname, '..', 'src', 'components', 'activity', 'run-card.tsx'].join(SEP);
const src = nodeFs.readFileSync(file, 'utf8');

describe('run card live ticker', () => {
  test('live ticker shows at least two lines instead of one', () => {
    // ticker is the mono Text inside live && latestEvent branch
    // must not be numberOfLines={1}
    const tickerMatch = src.match(/live && latestEvent[\s\S]*?numberOfLines=\{(\d+)\}/);
    expect(tickerMatch).not.toBeNull();
    const tickerLines = Number(tickerMatch![1]);
    expect(tickerLines).toBeGreaterThanOrEqual(2);
    expect(tickerLines).toBe(2);
    // ensure no single-line ticker remains
    const tickerBlock = src.slice(src.indexOf('live && latestEvent'), src.indexOf('live && latestEvent') + 500);
    expect(tickerBlock).not.toMatch(/numberOfLines=\{1\}/);
  });

  test('non-live summary stays clamped at two lines when collapsed', () => {
    // !live && run.summary branch: numberOfLines={expanded ? undefined : 2}
    expect(src).toContain('!live && run.summary');
    const summaryMatch = src.match(/!live && run\.summary[\s\S]*?numberOfLines=\{expanded \? undefined : (\d+)\}/);
    expect(summaryMatch).not.toBeNull();
    expect(Number(summaryMatch![1])).toBe(2);
  });

  test('ticker still renders inside live branch with mono variant', () => {
    expect(src).toMatch(/live && latestEvent[\s\S]*?variant=\"mono\"/);
  });
});

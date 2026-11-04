declare const __dirname: string;
const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const SEP = __dirname.includes('\\') ? '\\' : '/';

describe('roster purpose sentence extraction', () => {
  const src = fs.readFileSync([__dirname, '..', 'src', 'components', 'chat', 'chat-roster.tsx'].join(SEP), 'utf8');

  it('does not treat dots inside a hostname as sentence endings', () => {
    expect(src).toContain('export function botPurpose');
    expect(src).toContain('description.match(/^.*?(?:[.!?](?=\\s|$)|$)/)');
    expect(src).toContain("return first.trim().replace(/\\.$/, '')");
  });

  it('keeps unroutable and empty-description fallbacks', () => {
    expect(src).toContain('if (!botReportedRoutable(bot)) return botRowSubtitle(bot);');
    expect(src).toContain('if (!description) return botRowSubtitle(bot);');
  });
});

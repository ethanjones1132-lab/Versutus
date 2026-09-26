import { BOT_CREST_TONES, botCrestFromId } from '@/lib/bot-avatar';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const mark = () => readSource('src', 'components', 'brand', 'versutus-mark.tsx');
const avatarDerivation = () => readSource('src', 'lib', 'bot-avatar.ts');

const RETIRED_IDENTITY = /#1E3A6E|#D6B76A|sapphire/i;

describe('brand identity reads violet/cool on the near-black stage', () => {
  test('the app mark drops the sapphire-navy gradient and focus-tint motif for brand violet', () => {
    const source = mark();
    expect(source).not.toMatch(RETIRED_IDENTITY);
    expect(source).not.toMatch(/accentWarm/);
    expect(source).toContain('<Stop stopColor={Palette.accent} />');
    expect(source).toContain('<Stop stopColor={Palette.backgroundRaised} />');
    expect(source).toContain('stroke={Palette.textPrimary}');
    expect(source).toContain('fill={Palette.background}');
  });

  test('the mark keeps its public props and motif geometry', () => {
    const source = mark();
    expect(source).toContain('size = 76');
    expect(source).toContain('showBackground = true');
    expect(source).toContain('type VersutusMarkProps');
    expect(source).toContain('d="M22 26 L38 54 L54 26"');
    expect(source).toContain('fill="url(#versutusMarkBg)"');
  });

  test('generated bot crests seed from brand violet instead of retired gold', () => {
    const source = avatarDerivation();
    expect(source).not.toMatch(RETIRED_IDENTITY);
    expect(source).toContain("{ from: '#A99DFF', to: '#5646D0' }, // violet — the brand's own");
    expect(source).toContain('#0A0A0B');
  });

  test('crest derivation stays deterministic and inside the declared tone set', () => {
    expect(BOT_CREST_TONES.length).toBeGreaterThanOrEqual(5);
    expect(botCrestFromId('researcher')).toEqual(botCrestFromId('researcher'));
    for (const id of ['default', '', '🤖-bot']) {
      expect(BOT_CREST_TONES).toContainEqual(botCrestFromId(id).tone);
    }
  });
});

import { BOT_AVATAR_ACCENTS, BOT_AVATAR_SHAPES, botAvatarFromId } from '@/lib/bot-avatar';

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

  test('generated bot avatars seed from brand violet instead of retired gold', () => {
    const source = avatarDerivation();
    expect(source).not.toMatch(RETIRED_IDENTITY);
    expect(source).toContain("'#8B7CFF', // brand violet — matches Palette.accent");
    expect(source).toContain('#0A0A0B');
  });

  test('avatar derivation stays deterministic and inside the declared accent set', () => {
    expect(BOT_AVATAR_ACCENTS).toHaveLength(5);
    expect(BOT_AVATAR_SHAPES.length * BOT_AVATAR_ACCENTS.length).toBe(15);
    expect(BOT_AVATAR_ACCENTS).toContain('#8B7CFF');
    expect(botAvatarFromId('researcher')).toEqual(botAvatarFromId('researcher'));
    for (const id of ['default', '', '🤖-bot']) {
      expect(BOT_AVATAR_ACCENTS).toContain(botAvatarFromId(id).accent);
    }
  });
});

import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import type { Skill } from '@/lib/gateway/skills';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const WEATHER: Skill = { name: 'weather', description: 'Look up the forecast' };
const GITHUB: Skill = { name: 'github-pr-workflow', description: 'Full PR lifecycle' };

describe('slash suggestions include fetched skills', () => {
  test('a fetched skill appears in the suggestions for a bare /', () => {
    const suggestions = getSlashCommandSuggestions(
      '/',
      null,
      [],
      {},
      [],
      Number.POSITIVE_INFINITY,
      [WEATHER, GITHUB],
    );
    const weather = suggestions.find((item) => item.value === '/weather');
    expect(weather).toBeDefined();
    expect(weather!.description).toBe('Look up the forecast');
    expect(weather!.family).toBe('Skill');
    expect(suggestions.some((item) => item.value === '/github-pr-workflow')).toBe(true);
  });

  test('built-in and dynamic-command ordering is unchanged when skills are present', () => {
    const without = getSlashCommandSuggestions('/', null, [], {}, [], Number.POSITIVE_INFINITY);
    const withSkills = getSlashCommandSuggestions(
      '/',
      null,
      [],
      {},
      [],
      Number.POSITIVE_INFINITY,
      [WEATHER],
    );
    expect(withSkills.filter((item) => item.family !== 'Skill').map((item) => item.value)).toEqual(
      without.map((item) => item.value),
    );
  });

  test('a skill cannot shadow a built-in slash', () => {
    const impostor: Skill = { name: 'help', description: 'not the real help' };
    const suggestions = getSlashCommandSuggestions(
      '/help',
      null,
      [],
      {},
      [],
      Number.POSITIVE_INFINITY,
      [impostor],
    );
    const help = suggestions.filter((item) => item.value === '/help');
    expect(help).toHaveLength(1);
    expect(help[0].description).not.toBe('not the real help');
    expect(help[0].family).not.toBe('Skill');
  });

  test('chat-screen feeds the known skill list into both suggestion sources', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    const starts = [...src.matchAll(/getSlashCommandSuggestions\(/g)];
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      const snippet = src.slice(start.index, (start.index ?? 0) + 400);
      expect(snippet).toMatch(/skillsState\.skills/);
    }
  });
});

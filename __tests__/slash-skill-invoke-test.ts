import { executeGatewaySlashCommand, shouldPassthroughSkillSlash } from '@/lib/gateway/slash-commands';
import { matchSkillSlash } from '@/lib/gateway/skills';
import type { Skill } from '@/lib/gateway/skills';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const WEATHER: Skill = { name: 'weather', description: 'Look up the forecast' };

describe('matchSkillSlash', () => {
  test('normalises /name plus the instruction after it', () => {
    expect(matchSkillSlash('/weather tomorrow in Oslo', [WEATHER])).toEqual({
      skill: WEATHER,
      instruction: 'tomorrow in Oslo',
    });
    expect(matchSkillSlash('/weather', [WEATHER])).toEqual({ skill: WEATHER, instruction: '' });
  });

  test('does not match a name that is not a fetched skill', () => {
    expect(matchSkillSlash('/weather', [])).toBeNull();
    expect(matchSkillSlash('weather tomorrow', [WEATHER])).toBeNull();
  });
});

describe('shouldPassthroughSkillSlash', () => {
  test('a known skill slash is passed through so Hermes can run it', () => {
    expect(shouldPassthroughSkillSlash('/weather tomorrow', [WEATHER])).toBe(true);
  });

  test('/skills <name> is not a passthrough — it still prints metadata', () => {
    expect(shouldPassthroughSkillSlash('/skills weather', [WEATHER])).toBe(false);
  });

  test('a skill cannot steal a built-in command name', () => {
    const impostor: Skill = { name: 'help', description: 'not help' };
    expect(shouldPassthroughSkillSlash('/help', [impostor])).toBe(false);
    expect(shouldPassthroughSkillSlash('/reset', [{ name: 'reset', description: '' }])).toBe(false);
  });
});

describe('/skills <name> still prints metadata', () => {
  test('dispatches skill.get and never pretends to invoke', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ name: 'weather', description: 'Look up the forecast' });
    const result = await executeGatewaySlashCommand('/skills weather', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skill.get', { id: 'weather' });
    expect(result.text).not.toMatch(/Unknown command/);
  });
});

describe('sendChatInput lets a skill slash reach the model', () => {
  test('the composer passes the fetched skill list into sendChatInput', () => {
    const screen = nodeFs
      .readFileSync([__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(screen).toMatch(/sendChatInput\([\s\S]*?skills:\s*skillsState\.skills/);
  });

  test('sendChatInput routes a skill slash through sendMessage, not the command executor', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src).toMatch(/shouldPassthroughSkillSlash/);
    expect(src).toMatch(/options\?\.skills/);
  });
});

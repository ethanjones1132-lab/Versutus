import { matchSkillSlash, skillInvokePrefillsComposer, skillsListCopy, skillSlashText } from '@/lib/gateway/skills';
import type { Skill } from '@/lib/gateway/skills';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const WEATHER: Skill = { name: 'weather', description: 'Look up the forecast' };

test('a pane tap builds the same /<skill-name> turn the typed path dispatches', () => {
  expect(skillSlashText('weather')).toBe('/weather');
  expect(skillSlashText('  weather  ')).toBe('/weather');
});

test('the tapped text matches what the typed skill dispatch judges', () => {
  expect(matchSkillSlash(skillSlashText('weather'), [WEATHER])).toEqual({ skill: WEATHER, instruction: '' });
  expect(matchSkillSlash(skillSlashText('weather') + ' tomorrow', [WEATHER])?.skill).toEqual(WEATHER);
});

test('a tap dispatches when idle and connected, and only prefills otherwise', () => {
  expect(skillInvokePrefillsComposer({ status: 'connected', isSending: false, isCommandRunning: false })).toBe(false);
  expect(skillInvokePrefillsComposer({ status: 'connected', isSending: true, isCommandRunning: false })).toBe(true);
  expect(skillInvokePrefillsComposer({ status: 'connected', isSending: false, isCommandRunning: true })).toBe(true);
  expect(skillInvokePrefillsComposer({ status: 'connecting', isSending: false, isCommandRunning: false })).toBe(true);
  expect(skillInvokePrefillsComposer({ status: 'disconnected', isSending: false, isCommandRunning: false })).toBe(true);
});

test('a skill row tap fires the invoke callback with the row name', () => {
  const pane = readSource('src', 'components', 'chat', 'skills-pane.tsx');
  expect(pane).toContain('onInvoke');
  expect(pane).toMatch(/onPress=\{onInvoke \? \(\) => onInvoke\(skill\.name\) : undefined\}/);
});

test('list rendering and copy stay unchanged', () => {
  const pane = readSource('src', 'components', 'chat', 'skills-pane.tsx');
  expect(pane).toContain('title={skill.name}');
  expect(pane).toContain('subtitle={skill.description || undefined}');
  expect(pane).toContain('skillsListCopy(state)');
  // The copy contract itself is untouched: failed-first, stale re-read, empty.
  expect(skillsListCopy({ skills: [], loaded: false, failed: true })).toBe('Skills could not be read.');
  expect(skillsListCopy({ skills: [WEATHER], loaded: true, failed: true })).toBe(
    'Could not re-read skills — showing the last list.',
  );
  expect(skillsListCopy({ skills: [], loaded: true, failed: false })).toBe('No skills.');
});

test('chat-screen dispatches the tap through the skill-turn path, prefilling only when a turn cannot start', () => {
  const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
  expect(screen).toContain('handleSkillInvoke');
  expect(screen).toContain('skillInvokePrefillsComposer');
  expect(screen).toContain('skillSlashText(skillName)');
  // Dispatch reuses the typed skill-turn entry with the fetched list, so a
  // rejected turn surfaces through the normal turn-error path.
  expect(screen).toMatch(/sendChatInput\(skillSlashText\(skillName\), \{\s*skills: skillsState\.skills \}\)/);
  expect(screen).toContain('onInvoke={handleSkillInvoke}');
});

test('a rejected skill turn still surfaces through the normal turn-error path', () => {
  const provider = readSource('src', 'context', 'gateway-provider.tsx');
  // The tap dispatches via sendChatInput -> sendMessage; sendMessage renders
  // failures into the transcript instead of throwing past the caller.
  expect(provider).toContain('convertStreamError(prev, runId');
  expect(provider).toContain('markInterrupted(prev, runId, message)');
});

test('the typed /<skill-name> dispatch and / autocomplete stay untouched', () => {
  const provider = readSource('src', 'context', 'gateway-provider.tsx');
  expect(provider).toContain('shouldPassthroughSkillSlash(trimmed, options?.skills ?? [])');
  const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
  expect(screen).toMatch(/sendChatInput\([\s\S]*?skills:\s*skillsState\.skills/);
  expect(screen).toContain('getSlashCommandSuggestions(');
});

import { botChromeCombined, botChromeToggleLabel } from '@/lib/gateway/bot-chrome';
import { EMPTY_ROUTINES, routinesToggleLabel } from '@/lib/gateway/routines';
import { EMPTY_SKILLS, skillsToggleLabel } from '@/lib/gateway/skills';
import { EMPTY_TOOLSETS, toolsetsToggleLabel } from '@/lib/gateway/toolsets';

describe('botChromeCombined', () => {
  test('Bot Chat uses one strip; configurable chat still shows Tools alone', () => {
    expect(botChromeCombined({ kind: 'bot' })).toBe(true);
    expect(botChromeCombined({ kind: 'configurable' })).toBe(false);
    expect(botChromeCombined({ kind: 'roster' })).toBe(false);
    expect(botChromeCombined({ kind: 'group' })).toBe(false);
  });
});

describe('botChromeToggleLabel', () => {
  test('a closed strip is Bot; open hides it', () => {
    expect(botChromeToggleLabel(false)).toBe('Bot');
    expect(botChromeToggleLabel(true)).toBe('Hide Bot');
  });

  test('inner pane labels stay Skills, Tools, and Routines', () => {
    expect(skillsToggleLabel(EMPTY_SKILLS, false)).toBe('Skills');
    expect(toolsetsToggleLabel(EMPTY_TOOLSETS, false)).toBe('Tools');
    expect(routinesToggleLabel(EMPTY_ROUTINES, false)).toBe('Routines');
    expect(botChromeToggleLabel(false)).not.toBe(skillsToggleLabel(EMPTY_SKILLS, false));
    expect(botChromeToggleLabel(false)).not.toBe(toolsetsToggleLabel(EMPTY_TOOLSETS, false));
    expect(botChromeToggleLabel(false)).not.toBe(routinesToggleLabel(EMPTY_ROUTINES, false));
  });
});

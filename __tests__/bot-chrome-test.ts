import { botChromeCombined, botChromeToggleLabel } from '@/lib/gateway/bot-chrome';
import { EMPTY_ROUTINES, routinesToggleLabel } from '@/lib/gateway/routines';
import { EMPTY_SKILLS, skillsToggleLabel } from '@/lib/gateway/skills';
import { EMPTY_TOOLSETS, toolsetsToggleLabel } from '@/lib/gateway/toolsets';

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

describe('the Bot chrome voice picker', () => {
  test('it draws the fold’s own rows, and authors no label or identifier of its own', () => {
    const chrome = readSource('src', 'components', 'chat', 'bot-chrome.tsx');

    // Every row comes off the options the pure fold answered
    // (`src/lib/voice/bot-voices.ts`), so the order the operator sees and what
    // counts as a voice are that module's rules rather than a second copy here.
    expect(chrome).toMatch(/voiceOptions\?\.map\(\(option\) => \(/);
    expect(chrome).toMatch(/label=\{option\.label\}/);
    expect(chrome).toMatch(/selected=\{option\.selected\}/);
    // A row's tap hands the fold's own identifier back — absent on the row that
    // means the platform's default, which is how a voice is cleared.
    expect(chrome).toMatch(/onPress=\{\(\) => onVoiceSelect\?\.\(option\.identifier\)\}/);
  });

  test('a device with no voice is offered no section rather than a row that cannot change anything', () => {
    const chrome = readSource('src', 'components', 'chat', 'bot-chrome.tsx');

    expect(chrome).toMatch(/const showVoice = !!voiceOptions\?\.length && !!onVoiceSelect;/);
    // The picker reaches neither the package nor the store: it is handed rows
    // and a callback, and knows nothing else about either.
    expect(chrome).not.toContain('expo-speech');
    expect(chrome).not.toContain('voice-preferences');
  });
});

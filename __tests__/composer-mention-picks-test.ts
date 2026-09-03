import { extractMentions, insertMention, mentionPicksAtCaret } from '@/lib/gateway/mentions';

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

const ROSTER = ['researcher', 'coder', 'default'];

test('a caret @token yields roster picks, narrowing with the prefix', () => {
  expect(mentionPicksAtCaret('hey @', 5, ROSTER)).toEqual(ROSTER);
  expect(mentionPicksAtCaret('hey @re', 7, ROSTER)).toEqual(['researcher']);
  expect(mentionPicksAtCaret('hey @RE', 7, ROSTER)).toEqual(['researcher']);
});

test('an unknown token yields no picks and stays ordinary text', () => {
  expect(mentionPicksAtCaret('hey @nobody', 11, ROSTER)).toEqual([]);
  expect(extractMentions('hey @nobody', ROSTER)).toEqual([]);
  expect(mentionPicksAtCaret('no at-sign here', 15, ROSTER)).toEqual([]);
});

test('picking a name inserts @id keeping the surrounding text', () => {
  expect(insertMention('hey @re', 7, 'researcher')).toBe('hey @researcher ');
  expect(insertMention('ask @co to review this', 7, 'coder')).toBe('ask @coder to review this');
  const drafted = insertMention('hey @re', 7, 'researcher');
  expect(extractMentions(drafted, ROSTER)).toEqual(['researcher']);
});

test('the Bot Chat composer offers the roster picks above the input', () => {
  const composer = readSource('src', 'components', 'chat', 'chat-composer.tsx');
  expect(composer).toContain('mentionPicks');
  expect(composer).toContain('onSelectMention');
  expect(composer).toContain('Mention');
  // Picks render as @id rows through the same palette chrome as commands.
  expect(composer).toContain('@{botId}');
});

test('chat-screen feeds the composer from the roster Bot ids', () => {
  const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
  expect(screen).toContain('mentionPicksAtCaret(draft, draft.length, rosterBotIds)');
  expect(screen).toContain('insertMention(draft, draft.length, botId)');
  expect(screen).toContain('rosterBots.map((bot) => bot.id)');
  expect(screen).toContain('mentionPicks={mentionPicks}');
  expect(screen).toContain('onSelectMention={handleSelectMention}');
});

test('group-room autocomplete and handoff delivery stay untouched', () => {
  const room = readSource('src', 'components', 'chat', 'group-room-view.tsx');
  expect(room).toContain('mentionPicksAtCaret(draft, draft.length, group.memberIds)');
  const provider = readSource('src', 'context', 'gateway-provider.tsx');
  expect(provider).toContain('client.handoffMention');
  expect(provider).toContain('handoffFailedNote(toId, detail)');
});

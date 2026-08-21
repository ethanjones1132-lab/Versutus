import { extractMentions, mentionPrefix } from '@/lib/gateway/mentions';

test('extractMentions returns roster ids only', () => {
  const ids = ['researcher', 'coder', 'default'];
  expect(extractMentions('hey @researcher look at this @nobody @coder', ids)).toEqual([
    'researcher',
    'coder',
  ]);
  expect(extractMentions('email me @user@example.com', ids)).toEqual([]);
  expect(extractMentions('@Researcher', ids)).toEqual(['researcher']);
});

test('mentionPrefix matches Desktop handoff attribution', () => {
  expect(mentionPrefix('coder', 'look at this')).toBe('Message from 🤖 coder (@coder):\n\nlook at this');
});

import { threadStarters, threadWelcomeTitle } from '@/lib/gateway/thread-starters';

describe('thread starters', () => {
  test('a Bot chat and a direct chat each offer three starting points', () => {
    expect(threadStarters('bot')).toHaveLength(3);
    expect(threadStarters('direct')).toHaveLength(3);
  });

  test('starters are plain words the operator could have typed — never slash commands', () => {
    for (const starter of [...threadStarters('bot'), ...threadStarters('direct')]) {
      expect(starter.draft.startsWith('/')).toBe(false);
      expect(starter.label.startsWith('/')).toBe(false);
      expect(starter.label.length).toBeLessThanOrEqual(28);
      expect(starter.draft.length).toBeGreaterThan(starter.label.length - 12);
    }
  });

  test('the welcome names the Bot, and falls back to an open question', () => {
    expect(threadWelcomeTitle('Forge')).toBe('How can Forge help?');
    expect(threadWelcomeTitle('  ')).toBe('What’s on your mind?');
    expect(threadWelcomeTitle(undefined)).toBe('What’s on your mind?');
  });
});

import { CALL_SHORTCUT, botChatShortcut, recentBotShortcuts } from '@/lib/gateway/shortcuts';
import { deepLinkTarget } from '@/lib/gateway/deep-link';

/** Fold a shortcut URL the way `Linking.parse` + the router do. */
function targetOf(url: string) {
  const rest = url.replace(/^versutus:\/\//, '');
  const [path, queryString = ''] = rest.split('?');
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(queryString)) query[key] = value;
  return deepLinkTarget(path, query);
}

describe('app shortcuts reuse the one link vocabulary', () => {
  test('a Bot shortcut is the chat link the router already answers', () => {
    const shortcut = botChatShortcut('scout');
    expect(shortcut).toEqual({
      id: 'bot-scout',
      shortLabel: 'scout',
      longLabel: 'Talk to scout',
      url: 'versutus://chat?bot=scout',
    });
    expect(targetOf(shortcut.url)).toEqual({ kind: 'chat', botId: 'scout' });
  });

  test('a padded or unsafe Bot id is trimmed and encoded into the link', () => {
    expect(botChatShortcut('  scout  ').url).toBe('versutus://chat?bot=scout');
    expect(botChatShortcut('a b').url).toBe('versutus://chat?bot=a%20b');
  });

  test('recent Bots are trimmed, deduped and capped at three', () => {
    const shortcuts = recentBotShortcuts([' a ', 'b', 'a', '', 'c', 'd']);
    expect(shortcuts.map((shortcut) => shortcut.id)).toEqual(['bot-a', 'bot-b', 'bot-c']);
    expect(shortcuts.every((shortcut) => targetOf(shortcut.url)?.kind === 'chat')).toBe(true);
  });

  test('the static call shortcut folds to the call target', () => {
    expect(CALL_SHORTCUT.url).toBe('versutus://call');
    expect(targetOf(CALL_SHORTCUT.url)).toEqual({ kind: 'call', engine: 'auto', autoStart: false });
  });
});

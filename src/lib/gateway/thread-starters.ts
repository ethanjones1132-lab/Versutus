/**
 * The starting points an empty thread offers. Each one is a sentence the
 * operator could have typed — tapping it puts the words in the composer for
 * review, it never sends on its own. Plain words, no slash commands: the
 * palette is one tap behind the composer's `+` for anyone who wants those.
 */

export type ThreadStarter = { label: string; draft: string };

const BOT_STARTERS: ThreadStarter[] = [
  { label: 'What needs my attention?', draft: 'What needs my attention today?' },
  { label: 'Catch me up', draft: 'Catch me up on what you worked on since we last spoke.' },
  { label: 'What can you do?', draft: 'What can you do for me, and what do you need from me to do it?' },
];

const DIRECT_STARTERS: ThreadStarter[] = [
  { label: 'Think something through', draft: 'Help me think through ' },
  { label: 'Draft a message', draft: 'Draft a short, warm message to ' },
  { label: 'Explain it simply', draft: 'Explain this simply: ' },
];

/** The starters for a Bot's chat, or for a direct chat with no Bot in between. */
export function threadStarters(kind: 'bot' | 'direct'): ThreadStarter[] {
  return kind === 'bot' ? BOT_STARTERS : DIRECT_STARTERS;
}

/** The empty thread's serif prompt. */
export function threadWelcomeTitle(botName: string | undefined): string {
  const name = botName?.trim();
  return name ? `How can ${name} help?` : 'What’s on your mind?';
}

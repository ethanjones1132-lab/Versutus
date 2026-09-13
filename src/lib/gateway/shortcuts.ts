// ─── App shortcuts ride the one deep-link router ──────────────────────────
// A Siri phrase or an Android launcher shortcut is just a `versutus://` link.
// This module builds only links the shipped router already answers, so a
// shortcut cannot invent a second entry point (FUTURE-ITEMS item 8).

/** What a launcher or Siri donation needs to name one shortcut. */
export type AppShortcut = {
  id: string;
  shortLabel: string;
  longLabel: string;
  url: string;
};

/** `versutus://chat?bot=<id>` — the Bot Chat with the composer focused. */
export function botChatShortcut(botId: string): AppShortcut {
  const id = botId.trim();
  return {
    id: `bot-${id}`,
    shortLabel: id,
    longLabel: `Talk to ${id}`,
    url: `versutus://chat?bot=${encodeURIComponent(id)}`,
  };
}

/** The most recent Bots, deduped and trimmed, as launcher shortcuts. */
export function recentBotShortcuts(botIds: string[], limit = 3): AppShortcut[] {
  const seen = new Set<string>();
  const shortcuts: AppShortcut[] = [];
  for (const botId of botIds) {
    const id = botId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    shortcuts.push(botChatShortcut(id));
    if (shortcuts.length >= limit) break;
  }
  return shortcuts;
}

/** The one static shortcut: the call entry without naming a Bot. */
export const CALL_SHORTCUT: AppShortcut = {
  id: 'voice-call',
  shortLabel: 'Voice call',
  longLabel: 'Start a Versutus voice call',
  url: 'versutus://call',
};

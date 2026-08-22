export const BOT_CHAT_TITLE = 'Bot Chat';

/** Profile pin written by `hermes -p <id> config set model.*` (ADR 0015). */
export type BotPinnedModel = { default: string | null; provider: string | null };

export type PublicBot = {
  id: string;
  displayName: string;
  routable: boolean;
  /** Reported by newer Gates; absent on older ones — the roster degrades gracefully. */
  description?: string | null;
  /** Present when the profile carries a model pin; null/absent when unpinned or unknown. */
  model?: BotPinnedModel | null;
};

/**
 * One-line roster subtitle: routing state, plus the pinned default model when
 * the Gate reports one. Never renders the description here — that belongs to
 * a detail surface, not every row.
 */
export function botRowSubtitle(bot: PublicBot): string {
  if (!bot.routable) return 'No listen key';
  const pin = bot.model?.default ?? null;
  return pin ? `Bot · ${pin}` : 'Bot';
}

export type RosterRow =
  | { kind: 'configurable' }
  | { kind: 'bot'; bot: PublicBot };

export type ChatSurface =
  | { kind: 'roster' }
  | { kind: 'configurable' }
  | { kind: 'bot'; botId: string };

export function buildRoster(bots: PublicBot[]): RosterRow[] {
  return [{ kind: 'configurable' }, ...bots.map((bot) => ({ kind: 'bot' as const, bot }))];
}

export function isBotChat(session: { title?: string | null }): boolean {
  return session.title === BOT_CHAT_TITLE;
}

export function findBotChat<T extends { title?: string | null }>(sessions: T[]): T | undefined {
  return sessions.find((session) => isBotChat(session));
}

export async function ensureBotChat<T extends { title?: string | null }>(
  sessions: T[],
  create: (title: string) => Promise<T>,
): Promise<T> {
  return findBotChat(sessions) ?? create(BOT_CHAT_TITLE);
}

export async function loadBotChat<T extends { title?: string | null }>(
  list: () => Promise<T[]>,
  create: (title: string) => Promise<T>,
): Promise<T> {
  const sessions = await list();
  return ensureBotChat(sessions, create);
}

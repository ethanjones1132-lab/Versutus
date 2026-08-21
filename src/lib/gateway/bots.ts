export const BOT_CHAT_TITLE = 'Bot Chat';

export type PublicBot = { id: string; displayName: string; routable: boolean };

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

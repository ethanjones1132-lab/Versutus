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

/** What the phone's bot edit form can change. The name is identity (ADR 0011) and is not editable. */
export type BotEditDraft = {
  soul?: string;
  description?: string;
  modelId?: string;
  providerId?: string;
};

/**
 * Prefill an edit form from what the Gate reports. SOUL.md's current text is
 * not part of the roster payload, so the soul field starts empty — there it
 * means "leave unchanged", never "clear".
 */
export function botToEditInput(bot: PublicBot): {
  name: string;
  description: string;
  modelId: string;
  providerId: string;
} {
  return {
    name: bot.displayName,
    description: bot.description ?? '',
    modelId: bot.model?.default ?? '',
    providerId: bot.model?.provider ?? '',
  };
}

/**
 * Fields the edit form owns, expressed as an update patch. The Gate applies
 * only what the request carries and leaves absent fields untouched, so a
 * blank field means "leave unchanged" — fixing a typo'd description must
 * never wipe a model pin the form did not show.
 */
export function buildBotUpdatePatch(input: BotEditDraft): BotEditDraft {
  const patch: BotEditDraft = {};
  for (const key of ['soul', 'description', 'modelId', 'providerId'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) patch[key] = value.trim();
  }
  return patch;
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

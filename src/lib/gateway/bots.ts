export const BOT_CHAT_TITLE = 'Bot Chat';

/** Profile pin written by `hermes -p <id> config set model.*` (ADR 0015). */
export type BotPinnedModel = { default: string | null; provider: string | null };

/**
 * Why a Bot cannot route. Reported by newer Gates alongside the boolean:
 *   - 'listen_key_missing': the profile .env carries no API_SERVER_KEY.
 *   - 'default_key_refused': the profile still holds the default profile's
 *     listen key, which Hermes multiplex refuses on any named prefix
 *     (ADR 0005) — a distinct fix (set a distinct key), so it gets its own
 *     indicator instead of sharing "no key".
 */
export type BotRoutingIssue = 'listen_key_missing' | 'default_key_refused';

export type PublicBot = {
  id: string;
  displayName: string;
  routable: boolean;
  /** Reported by newer Gates; absent/null on older ones — degrade to the boolean. */
  routingIssue?: BotRoutingIssue | null;
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
  if (bot.routingIssue === 'default_key_refused') return 'Default listen key refused';
  if (!bot.routable || bot.routingIssue === 'listen_key_missing') return 'No listen key';
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

/**
 * Roster search. Navigation rows (configurable chat) always survive so the
 * operator never loses the way back; Bot rows match a case-insensitive
 * substring over display name, id, and description. A blank query is "no
 * filter", not "nothing matches".
 */
export function filterRosterRows(rows: RosterRow[], query: string): RosterRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    if (row.kind !== 'bot') return true;
    const bot = row.bot;
    return [bot.displayName, bot.id, bot.description].some(
      (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
    );
  });
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

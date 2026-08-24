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

/**
 * The micro model label on a group-room member chip: the pinned default when
 * the Gate reports one, '' otherwise — an unpinned member (or an older Gate
 * that reports no pins) renders silence, never 'null' or an empty pill.
 */
export function botChipModelPin(bot: PublicBot): string {
  const pin = bot.model?.default?.trim();
  return pin || '';
}

/**
 * The unroutable tag on a group-room member chip: '' when the member can
 * route, else the same verdict words the roster row uses ('No listen key' /
 * 'Default listen key refused'). Same precedence as botRowSubtitle — a
 * reported routingIssue wins over a stale routable boolean, and older Gates
 * that report neither degrade to the boolean alone.
 */
export function botChipRoutingTag(bot: PublicBot): string {
  if (bot.routingIssue === 'default_key_refused') return 'Default listen key refused';
  if (!bot.routable || bot.routingIssue === 'listen_key_missing') return 'No listen key';
  return '';
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
  | { kind: 'bot'; botId: string }
  | { kind: 'group'; groupId: string };

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

/**
 * What the roster's footer may honestly claim when the visible list comes up
 * short. Three truths it must not blur:
 *   - A FAILED inventory is not "zero bots" — the phone does not know what
 *     the host has, so the failure names itself instead of asserting emptiness.
 *   - A query that matched group rooms but no agents is not "no match" — the
 *     operator is looking at a match right below the banner.
 *   - A blank query is never "no match" — nothing was filtered.
 */
export type RosterEmptyView =
  | { kind: 'none' }
  | { kind: 'zero-bots' }
  | { kind: 'load-failed'; reason: string }
  | { kind: 'no-match'; query: string };

export function rosterEmptyView({
  totalBotRows,
  visibleBotRows,
  visibleGroups,
  query,
  error,
}: {
  totalBotRows: number;
  visibleBotRows: number;
  visibleGroups: number;
  query: string;
  error?: string;
}): RosterEmptyView {
  if (totalBotRows <= 0) {
    return typeof error === 'string' && error.trim()
      ? { kind: 'load-failed', reason: error }
      : { kind: 'zero-bots' };
  }
  const needle = query.trim();
  if (!needle) return { kind: 'none' };
  if (visibleBotRows <= 0 && visibleGroups <= 0) return { kind: 'no-match', query: needle };
  return { kind: 'none' };
}

/**
 * Why creation rows are missing from this roster, in the order they would
 * have sat. Hiding "New Agent" / "New Group Room" on gateways that cannot
 * manage agents or host rooms was honest about the refusal — it hid the rows
 * instead of springing one after the sheet was filled — but hiding is not
 * explaining: an operator staring at a shrunken roster with no words
 * concludes the app is broken. One caption per missing capability, honest
 * about what still works. Client-only: decided from probes already made,
 * zero new Gate calls.
 */
export function rosterCapabilityNotes({
  hasBotManagement,
  hasGroupRooms,
}: {
  hasBotManagement: boolean;
  hasGroupRooms: boolean;
}): string[] {
  const notes: string[] = [];
  if (!hasBotManagement) {
    notes.push('This gateway does not create agents — chat and runs still work.');
  }
  if (!hasGroupRooms) {
    notes.push('This gateway does not host group rooms.');
  }
  return notes;
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

/**
 * What the probe looks for on a client surface: a manifest client's own word
 * (`canManageBots`) about whether its document advertises a bots endpoint, or
 * failing that, the bots-dialect call itself. Loosely typed on purpose —
 * adapters are probed structurally, not by importing portal types.
 */
export type BotManagementSurface = {
  canManageBots?: unknown;
  createBot?: unknown;
};

/**
 * Can this gateway create and edit Bots? Decided BEFORE the operator fills
 * the form: adapters that never speak bots (OpenClaw, plain Hermes HTTP)
 * omit createBot entirely, and a manifest client whose document declares no
 * bots endpoint says so through canManageBots. Either way the roster hides
 * "New Agent" instead of springing the refusal after the sheet is filled.
 */
export function hasBotManagement(client?: object | null): boolean {
  if (!client) return false;
  const surface = client as BotManagementSurface;
  if (typeof surface.canManageBots === 'boolean') return surface.canManageBots;
  return typeof surface.createBot === 'function';
}

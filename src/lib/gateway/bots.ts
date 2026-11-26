import { botRoutingView } from './bot-detail';

export const BOT_CHAT_TITLE = 'Bot Chat';

/** Profile pin written by `hermes -p <id> config set model.*` (ADR 0015). */
export type BotPinnedModel = { default: string | null; provider: string | null };

/**
 * Why a Bot cannot route. Reported by newer Gates alongside the boolean:
 *   - 'listen_key_missing': the profile .env carries no API_SERVER_KEY.
 *   - 'multiplex_disabled': the host has `gateway.multiplex_profiles` off, so
 *     `/p/<name>/` is not an address at all — Hermes ignores the prefix and
 *     serves the default profile. This outranks the key verdict because a
 *     distinct key cannot help until multiplex is on.
 *   - 'default_key_refused': the profile still holds the default profile's
 *     listen key, which Hermes multiplex refuses on any named prefix
 *     (ADR 0005) — a distinct fix (set a distinct key), so it gets its own
 *     indicator instead of sharing "no key".
 */
export type BotRoutingIssue = 'listen_key_missing' | 'multiplex_disabled' | 'default_key_refused';

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
  /**
   * Which runtime the Bot lives on, reported once the Gate serves Bots from
   * more than one environment (ADR 0016). Absent on a single-runtime Gate,
   * where every Bot is a Hermes profile.
   */
  runtime?: string | null;
  /** The environment that owns the Bot — the one a create or edit is aimed at. */
  backendId?: string | null;
};

/**
 * The families a Bot's `runtime` can name. The Gate reports adapter ids
 * (`claude-code`, `codex`), but the app only ever needs the family — the
 * label, the roster order and the feature surface all key on it, so one
 * spelling of the id cannot make a Claude Code Bot look like an unknown.
 * `hermes` covers absent/blank too: a Bot with no reported runtime is what a
 * Bot has always been (ADR 0016).
 */
export type BotRuntimeFamily = 'hermes' | 'opencode' | 'claude-code' | 'codex' | 'other';

/** The family a runtime id belongs to, normalised for case and whitespace. */
export function botRuntimeFamily(runtime?: string | null): BotRuntimeFamily {
  const id = runtime?.trim().toLowerCase();
  if (!id || id.startsWith('hermes')) return 'hermes';
  if (id.startsWith('opencode')) return 'opencode';
  if (id.startsWith('claude')) return 'claude-code';
  if (id.startsWith('codex')) return 'codex';
  return 'other';
}

/**
 * The runtime's name for a roster row, or '' for Hermes and for a Gate that
 * does not say — Hermes is what a Bot has always been, so it earns no tag.
 * Claude Code and Codex Bots are fixed Gate Bots (VS-093) and still earn one.
 */
export function botRuntimeLabel(runtime?: string | null): string {
  const trimmed = runtime?.trim();
  if (!trimmed) return '';
  switch (botRuntimeFamily(trimmed)) {
    case 'hermes':
      return '';
    case 'opencode':
      return 'OpenCode';
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    default:
      return trimmed;
  }
}

/**
 * The Hermes-profile features a Bot's runtime carries. Chat, sessions and the
 * roster are universal; every flag here is something read from a Hermes
 * profile's own file tree (ADR 0016) and refused by name elsewhere. Modelled
 * as one object so every pane asks the same question instead of each surface
 * inventing its own "not OpenCode" test that the next runtime forgets.
 */
export type BotProfileFeatures = {
  /** The Bot's own Hermes API-server credential (multiplex). */
  listenKey: boolean;
  /** MEMORY.md / USER.md under the profile. */
  memory: boolean;
  /** skills.list and skill invocation. */
  skills: boolean;
  /** `[bot:<name>]` cron routines. */
  routines: boolean;
};

const HERMES_PROFILE_FEATURES: BotProfileFeatures = {
  listenKey: true,
  memory: true,
  skills: true,
  routines: true,
};

const REDUCED_PROFILE_FEATURES: BotProfileFeatures = {
  listenKey: false,
  memory: false,
  skills: false,
  routines: false,
};

/**
 * The features this Bot's runtime can honestly serve. Only a Hermes Bot —
 * runtime absent or `hermes` — has the profile tree these need; OpenCode,
 * Claude Code and Codex Bots get the reduced surface rather than a pane that
 * offers a request the Gate will refuse.
 */
export function botProfileFeatures(runtime?: string | null): BotProfileFeatures {
  return botRuntimeFamily(runtime) === 'hermes' ? HERMES_PROFILE_FEATURES : REDUCED_PROFILE_FEATURES;
}

/** Whether this Bot is a Hermes profile (runtime absent or `hermes`). */
export function botHasHermesFeatures(runtime?: string | null): boolean {
  return botRuntimeFamily(runtime) === 'hermes';
}

/**
 * Whether this Bot's runtime lets the phone write it. Claude Code and Codex
 * Bots are fixed by the Gate (VS-093): the phone cannot create or edit them,
 * so the edit affordances hide rather than inviting a refusal. Hermes,
 * OpenCode and a runtime the app does not know keep the form they always had.
 */
export function botRuntimeWritable(runtime?: string | null): boolean {
  const family = botRuntimeFamily(runtime);
  return family !== 'claude-code' && family !== 'codex';
}

/**
 * One-line roster subtitle: routing state, plus the pinned default model when
 * the Gate reports one. Never renders the description here — that belongs to
 * a detail surface, not every row.
 */
export function botRowSubtitle(bot: PublicBot): string {
  // The verdict itself — which issue outranks which — lives in botRoutingView
  // so the row, the chip and Details cannot disagree. The row keeps its own
  // one-line copy: the key's name belongs to Details, not every roster row.
  const issue = botRoutingView(bot).issue;
  if (issue === 'multiplex_disabled') return 'Multiplex is off';
  if (issue !== null) return 'Not set up yet';
  const pin = bot.model?.default ?? null;
  const kind = botRuntimeLabel(bot.runtime);
  const label = kind ? `${kind} Bot` : 'Bot';
  return pin ? `${label} · ${pin}` : label;
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
 * route, else the same verdict words the roster row uses ('Multiplex is off' /
 * 'Not set up yet'). Same precedence as botRowSubtitle — a reported
 * routingIssue wins over a stale routable boolean, and older Gates that report
 * neither degrade to the boolean alone.
 */
export function botChipRoutingTag(bot: PublicBot): string {
  // Same single verdict as the roster row (botRoutingView): the chip only
  // chooses silence for a routable member.
  const issue = botRoutingView(bot).issue;
  if (issue === null) return '';
  return issue === 'multiplex_disabled' ? 'Multiplex is off' : 'Not set up yet';
}

/** What the phone's bot edit form can change. The name is identity (ADR 0011) and is not editable. */
export type BotEditDraft = {
  soul?: string;
  description?: string;
  modelId?: string | null;
  providerId?: string | null;
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
 * only what the request carries and leaves absent fields untouched; null is
 * reserved for the explicit instruction to clear a model pin.
 */
export function buildBotUpdatePatch(input: BotEditDraft): BotEditDraft {
  const patch: BotEditDraft = {};
  for (const key of ['soul', 'description', 'modelId', 'providerId'] as const) {
    const value = input[key];
    if (value === null) Object.assign(patch, { [key]: null });
    else if (typeof value === 'string' && value.trim()) patch[key] = value.trim();
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
 * short. Five truths it must not blur:
 *   - A FAILED inventory is not "zero bots" — the phone does not know what
 *     the host has, so the failure names itself instead of asserting emptiness.
 *   - An inventory the app could not even attempt (gateway not connected) is
 *     not "zero bots" either — the read never ran, so the footer waits for the
 *     connection instead of reporting a count it never measured.
 *   - A connection whose client has no roster call at all is the same kind of
 *     non-answer from the other side: `listBots` answers `[]` for it, so the
 *     footer must say the connection cannot inventory rather than assert the
 *     host has no Bots.
 *   - A query that matched group rooms but no agents is not "no match" — the
 *     operator is looking at a match right below the banner.
 *   - A blank query is never "no match" — nothing was filtered.
 */
export type RosterEmptyView =
  | { kind: 'none' }
  | { kind: 'zero-bots' }
  | { kind: 'uninventoried' }
  | { kind: 'load-failed'; reason: string }
  | { kind: 'waiting' }
  | { kind: 'no-match'; query: string };

/**
 * Whether the live client can inventory Bots at all: a Hermes client attached
 * without a manifest has no `listBots`, and the provider answers that absence
 * with `[]` so every reader keeps a list to work from — which makes an unread
 * roster look exactly like an empty one. The verdict is published here, the
 * same way `registerCrestFleet` publishes the fleet's tones, because the
 * roster draws from a module signal rather than from the gateway context.
 *
 * True is "no evidence to the contrary": the default before any client is
 * installed and again once one is torn down, so a disconnected gateway stays
 * "waiting" instead of claiming it could never inventory.
 */
let rosterInventoryAvailable = true;
const rosterInventoryListeners = new Set<() => void>();

/** Publish the installed client's verdict. Only a real change notifies. */
export function publishBotInventoryAvailable(available: boolean): void {
  if (available === rosterInventoryAvailable) return;
  rosterInventoryAvailable = available;
  for (const listener of rosterInventoryListeners) listener();
}

/** Whether the installed client carries a roster call (`useSyncExternalStore` snapshot). */
export function botInventoryAvailable(): boolean {
  return rosterInventoryAvailable;
}

export function subscribeBotInventoryAvailable(listener: () => void): () => void {
  rosterInventoryListeners.add(listener);
  return () => {
    rosterInventoryListeners.delete(listener);
  };
}

/** What the probe looks for on a client surface: the roster call itself. */
export type BotInventorySurface = { listBots?: unknown };

/**
 * Can this client read a Bot roster at all? Method presence, the same probe
 * `hasBotManagement` makes below: a manifest client whose document advertises
 * a bots endpoint implements the call, and a plain Hermes client omits it
 * entirely.
 */
export function hasBotInventory(client?: object | null): boolean {
  if (!client) return false;
  return typeof (client as BotInventorySurface).listBots === 'function';
}

export function rosterEmptyView({
  totalBotRows,
  visibleBotRows,
  visibleGroups,
  query,
  error,
  connected = true,
  inventoryAvailable = true,
}: {
  totalBotRows: number;
  visibleBotRows: number;
  visibleGroups: number;
  query: string;
  error?: string;
  /**
   * False while the gateway is down — the roster read is gated on a live
   * connection, so an empty list means "not read yet". Defaults true: a
   * caller that says nothing is claiming it ran the read.
   */
  connected?: boolean;
  /**
   * Whether the live client carries a roster call. Defaults true, so a caller
   * that says nothing keeps the existing answers; false turns an empty list
   * into "this connection cannot inventory", never "zero bots".
   */
  inventoryAvailable?: boolean;
}): RosterEmptyView {
  if (totalBotRows <= 0) {
    if (typeof error === 'string' && error.trim()) return { kind: 'load-failed', reason: error };
    if (!inventoryAvailable) return { kind: 'uninventoried' };
    return connected ? { kind: 'zero-bots' } : { kind: 'waiting' };
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

export function sessionBotChatBadge(session: { title?: string | null }): string | undefined {
  return isBotChat(session) ? BOT_CHAT_TITLE : undefined;
}

export function findBotChat<T extends { title?: string | null }>(sessions: T[]): T | undefined {
  return sessions.find((session) => isBotChat(session));
}

/** The little a Bot's chat row must carry to be found by the id a device remembers. */
export type BotChatRow = { id: string; title?: string | null };

/**
 * This device's memory of one Bot's chat, offered to an open.
 *
 * The remembered id is the identity; the canonical title is only a fallback.
 * A CLI backend retitles a session from its first prompt (Claude Code at
 * least), so a chat created as `Bot Chat` stops answering to that name after
 * its first turn, and matching on the title alone made every launch create a
 * fresh chat (VS-129).
 */
export type BotChatMemory<T extends BotChatRow> = {
  /** The session id this device last opened for the Bot. */
  id?: string | null;
  /**
   * Read that id directly. Asked only when the session list cannot prove the
   * session is still there — a partial window, or a list that failed entirely.
   * Scoped to the Bot by the caller, so another Bot's session cannot answer.
   */
  read?: (sessionId: string) => Promise<T | undefined>;
};

/** The listed row named by the id this device remembered, when the list carries it. */
export function findBotChatById<T extends BotChatRow>(
  sessions: T[],
  sessionId?: string | null,
): T | undefined {
  const wanted = sessionId?.trim();
  if (!wanted) return undefined;
  return sessions.find((session) => session.id === wanted);
}

/**
 * The chat this device remembers for a Bot: the listed row while the list still
 * carries it, else a direct read of the id. A read that fails, answers for some
 * other id, or says nothing proves nothing, so the caller keeps its title match
 * and its create.
 */
export async function findRememberedBotChat<T extends BotChatRow>(
  sessions: T[],
  memory?: BotChatMemory<T>,
): Promise<T | undefined> {
  const listed = findBotChatById(sessions, memory?.id);
  if (listed) return listed;
  const remembered = memory?.id?.trim();
  if (!remembered || !memory?.read) return undefined;
  try {
    const direct = await memory.read(remembered);
    return direct?.id === remembered ? direct : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session a direct `session.get` read answered with, when it is the one
 * that was asked for. The Gate and a native Hermes host answer with the session
 * itself or wrapped in `{ session }`; a read of another id is not this Bot's
 * chat and is refused here rather than adopted.
 */
export function botChatReadSession<T extends BotChatRow>(
  raw: unknown,
  sessionId: string,
): T | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const candidate =
    record.session && typeof record.session === 'object'
      ? (record.session as Record<string, unknown>)
      : record;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  if (id !== sessionId) return undefined;
  return candidate as unknown as T;
}

export async function ensureBotChat<T extends BotChatRow>(
  sessions: T[],
  create: (title: string) => Promise<T>,
  memory?: BotChatMemory<T>,
): Promise<T> {
  const remembered = memory?.id?.trim()
    ? await findRememberedBotChat(sessions, memory)
    : undefined;
  return remembered ?? findBotChat(sessions) ?? create(BOT_CHAT_TITLE);
}

export function loadBotChat<T extends BotChatRow>(
  list: () => Promise<T[]>,
  create: (title: string) => Promise<T>,
): Promise<T>;
export function loadBotChat<T extends BotChatRow>(
  list: () => Promise<T[]>,
  create: (title: string) => Promise<T>,
  isCurrent: () => boolean,
  memory?: BotChatMemory<T>,
): Promise<T | undefined>;
export async function loadBotChat<T extends BotChatRow>(
  list: () => Promise<T[]>,
  create: (title: string) => Promise<T>,
  isCurrent: () => boolean = () => true,
  memory?: BotChatMemory<T>,
): Promise<T | undefined> {
  const remember = memory?.id?.trim() ? memory : undefined;
  let sessions: T[];
  try {
    sessions = await list();
  } catch (error) {
    if (!isCurrent()) return undefined;
    // A failed list is not proof the remembered chat is gone: a Gate whose
    // session catalogue is momentarily unreadable still holds the thread, so
    // ask for the id itself before falling back to the old refusal.
    const remembered = remember ? await findRememberedBotChat([], remember) : undefined;
    if (remembered) return isCurrent() ? remembered : undefined;
    // A read that landed after the scope moved is not this open's refusal.
    if (!isCurrent()) return undefined;
    throw error;
  }
  // The client scope can change while listing: do not create on the next Bot.
  if (!isCurrent()) return undefined;
  // The remembered id outranks the title: a backend may have renamed the chat
  // since this device last opened it. The read is one more await, so the guard
  // is repeated before anything is created under whatever Bot is current now.
  const remembered = remember ? await findRememberedBotChat(sessions, remember) : undefined;
  if (!isCurrent()) return undefined;
  const chat = remembered ?? findBotChat(sessions);
  if (chat) return chat;
  let created: T;
  try {
    created = await create(BOT_CHAT_TITLE);
  } catch (error) {
    // A create that failed after the scope moved belongs to the Bot that was
    // left: it must not surface as the winning open's refusal.
    if (!isCurrent()) return undefined;
    throw error;
  }
  return isCurrent() ? created : undefined;
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

/**
 * What the per-Bot spend read looks for on a client surface: a manifest
 * client's own word (`canManageSessions`) about whether its document
 * advertises a sessions endpoint, and the scoped catalogue call itself —
 * `listBotSessionCatalogue`, which names the Bot in the query instead of
 * reading the app's stored Bot scope.
 */
export type BotSessionScopingSurface = {
  canManageSessions?: unknown;
  listBotSessionCatalogue?: unknown;
};

/**
 * Can this gateway read one Bot's own session catalogue? Decided BEFORE any
 * request: a plain Hermes HTTP adapter omits the scoped call entirely, and a
 * manifest client whose document declares no sessions route says so through
 * `canManageSessions`. Either way P5's per-Bot section degrades to the gateway
 * total alone instead of provoking a refusal per Bot — the same shape as
 * `hasBotManagement`, and for the same reason: hide what cannot finish.
 */
export function hasBotSessionScoping(client?: object | null): boolean {
  if (!client) return false;
  const surface = client as BotSessionScopingSurface;
  if (surface.canManageSessions === false) return false;
  return typeof surface.listBotSessionCatalogue === 'function';
}

/**
 * One Bot's standing instructions, read on demand when a Bot is opened. Kept
 * off PublicBot and off the roster payload: the roster is re-read constantly
 * and a soul can be long.
 */
export type BotSoulRead = { ok: true; soul: string | null } | { ok: false };

export type BotSoulState = {
  soul: string | null;
  /** True once a read has succeeded — a failed FIRST read has learned nothing. */
  loaded: boolean;
  failed: boolean;
};

export const EMPTY_BOT_SOUL: BotSoulState = { soul: null, loaded: false, failed: false };

/**
 * Fold one soul read into what the sheet shows. Three states stay distinct:
 * the Bot has a soul, it genuinely has none, or the read failed. The last must
 * never render as the middle one — telling an operator a Bot has no standing
 * instructions when the Gate simply could not answer is the same empty-vs-failed
 * lie the roster and rooms already refuse (see applyGroupRead).
 */
export function applyBotSoulRead(previous: BotSoulState, read: BotSoulRead): BotSoulState {
  if (read.ok) return { soul: read.soul, loaded: true, failed: false };
  if (previous.loaded) return { soul: previous.soul, loaded: true, failed: true };
  return { soul: null, loaded: false, failed: true };
}

/** The line under the soul, or undefined when the soul itself is the answer. */
export function botSoulCopy(state: BotSoulState): string | undefined {
  if (!state.loaded && state.failed) return 'The soul could not be read.';
  if (state.failed) return 'Could not re-read the soul — showing the last one.';
  if (state.loaded && state.soul === null) return 'No standing instructions.';
  return undefined;
}

/**
 * Read one `bots.get` payload. The `soul` field is always present on a Gate
 * that serves this method — absent means the host cannot answer, which is a
 * FAILED read, not "this Bot has none". Saying the latter would invent a fact
 * about the Bot out of a fact about the Gate.
 */
export function botSoulReadFromUnknown(raw: unknown): BotSoulRead {
  if (!raw || typeof raw !== 'object') return { ok: false };
  const record = raw as Record<string, unknown>;
  if (!('soul' in record)) return { ok: false };
  const soul = record.soul;
  if (soul === null) return { ok: true, soul: null };
  if (typeof soul === 'string') return { ok: true, soul: soul.trim() ? soul : null };
  return { ok: false };
}

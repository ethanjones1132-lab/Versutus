export const MAX_GROUP_MEMBERS = 6;
export const MIN_GROUP_MEMBERS = 2;
/**
 * How many rounds ONE phone send runs. The Gate's planner default is a
 * single round (gate/core/cli-environments/bot-groups.mjs): three rounds
 * produced nine near-identical replies on a three-bot room, so rounds are
 * a server-side power feature the phone never asks for — another turn is
 * another message, or an @mention. The client mirror must teach the same
 * plan so UI copy ("one round") and any future caller cannot drift back to
 * a multi-round send the wire does not run.
 */
export const GROUP_ROUNDS_ON_SEND = 1;
/** The Gate's own planner guard (maxMessages default): multiple rounds stop
 *  here. It can never bind a one-round send of at most six members — it is
 *  documented, never claimed as an outcome the phone could hit. */
export const MAX_GROUP_MESSAGES = 10;

/** A Gate-owned group room (wire shape of GET/POST /v1/bot-groups). */
export type BotGroupRoom = {
  id: string;
  name: string;
  memberIds: string[];
};

/** One bot's reply inside a group send (wire shape of deliverGroupMessage). */
export type GroupReply = { botId: string; text: string };

/** One stored room exchange line (wire shape of GET /v1/bot-groups/:id/messages). */
export type GroupTranscriptEntry = {
  id: string;
  role: 'user' | 'bot';
  text: string;
  botId?: string;
  at?: number;
};

/**
 * What the room view renders for one transcript line. `at` is the Gate's
 * epoch-ms stamp when the line was recorded (absent on older gates).
 */
export type RoomTranscriptRow =
  | { id: string; role: 'user'; text: string; at?: number }
  | { id: string; role: 'bot'; botId: string; text: string; at?: number };

/**
 * Fold stored transcript lines into room rows, oldest-first as stored. Rows
 * the view cannot render honestly (unknown roles, bot lines without an
 * author) are dropped rather than drawn broken. A timestamp survives only
 * when it is a real finite number — a corrupted stamp must not reach the UI.
 */
export function transcriptToRoomEntries(entries: GroupTranscriptEntry[]): RoomTranscriptRow[] {
  const rows: RoomTranscriptRow[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string') continue;
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : undefined;
    if (entry.role === 'user') {
      rows.push({ id: entry.id, role: 'user', text: entry.text, at });
    } else if (entry.role === 'bot' && typeof entry.botId === 'string') {
      rows.push({ id: entry.id, role: 'bot', botId: entry.botId, text: entry.text, at });
    }
  }
  return rows;
}

/** The minimal shape any rendered room line carries — storage rows and the
 *  view's richer local variants both fit under it. */
export type TranscriptRowLike = {
  id: string;
  role: 'user' | 'bot';
  text: string;
  at?: number;
  botId?: string;
};

/**
 * How close two stamps must be for a stored line to read as the Gate's copy
 * of a line this phone already shows. The Gate records the send moment with
 * its own clock and id (random hex, never the phone's `u-<ts>`), so a re-read
 * cannot dedupe by id alone; a byte-identical line stamped within the window
 * is the same message, not a new one.
 *
 * The window does DOUBLE duty: it is the send window (a copy is stamped a few
 * ms after the phone's optimistic row) AND the clock-skew budget. The phone
 * and the Gate rarely share a clock; a desktop drifted minutes ahead or
 * behind stamps the copy `local.at ± skew`, and a window that only covered
 * the send latency duplicated the operator's own bubbles on every refresh
 * past the skew (rook 2026-08-25). 5 minutes tolerates both directions while
 * staying finite — an identical line stamped beyond it cannot be told apart
 * from a genuinely new one and keeps its own place.
 */
export const TRANSCRIPT_DEDUPE_WINDOW_MS = 300_000;

function sameStoredLine<T extends TranscriptRowLike>(local: T, stored: RoomTranscriptRow): boolean {
  if (local.role !== stored.role || local.text !== stored.text) return false;
  if (local.role === 'bot') {
    // A bot reply is only the same line when the same bot said the same
    // thing — a stored line without an author never matches.
    if (stored.role !== 'bot' || local.botId !== stored.botId) return false;
  }
  if (typeof local.at !== 'number' || typeof stored.at !== 'number') return false;
  return Math.abs(local.at - stored.at) < TRANSCRIPT_DEDUPE_WINDOW_MS;
}

/**
 * Fold a fresh transcript read into the rows currently shown, oldest-first as
 * stored. Safe to call for the first replay AND for later pull-to-refresh
 * reads:
 *  - a stored line already shown (same id) is never re-added;
 *  - a stored line that is the Gate's copy of a line this phone sent this
 *    visit (same role/text, stamped within TRANSCRIPT_DEDUPE_WINDOW_MS) is
 *    skipped so a re-read cannot duplicate the optimistic copy — the local
 *    row stays because it carries the send-time meta (reply counts, routing
 *    verdicts, cap note) the storage row lacks;
 *  - corrupt lines never enter the view (dropped in transcriptToRoomEntries);
 *  - a failed or empty read never removes anything: the transcript is the
 *    conversation in front of the operator, not a cached inventory, so no
 *    refresh wipes it;
 *  - the fold stays CHRONOLOGICAL, not positional: a fresh read can carry
 *    lines OLDER than everything shown (first replay) or NEWER (another
 *    device sent since the last read). Rows sort by stamp, so a newer line
 *    lands below the conversation at the reading position — prepending
 *    every addition inverted it to the top (rook 2026-08-25). A line
 *    without a stamp (older gates) reads as oldest, so stored replay lines
 *    still land above this visit's optimistic sends.
 */
export function mergeTranscriptRows<T extends TranscriptRowLike>(
  current: T[],
  stored: GroupTranscriptEntry[],
): T[] {
  const known = new Set(current.map((row) => row.id));
  const additions = transcriptToRoomEntries(stored).filter(
    (row) => !known.has(row.id) && !current.some((local) => sameStoredLine(local, row)),
  );
  return [...current, ...additions].sort(
    (a, b) => (a.at ?? Number.NEGATIVE_INFINITY) - (b.at ?? Number.NEGATIVE_INFINITY),
  ) as T[];
}

const GROUP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Micro timestamp for a room line: clock time ('14:02') on today's lines,
 * short date ('Aug 23') for anything older — rooms rarely span years, so no
 * year form. Local time, plain date math (no Intl variance across JS
 * engines). Returns '' for a stamp that cannot be rendered.
 */
export function formatGroupMessageTime(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '';
  const atDate = new Date(at);
  const nowDate = new Date(now);
  const sameDay =
    atDate.getFullYear() === nowDate.getFullYear() &&
    atDate.getMonth() === nowDate.getMonth() &&
    atDate.getDate() === nowDate.getDate();
  if (!sameDay) {
    return `${GROUP_MONTHS[atDate.getMonth()]} ${atDate.getDate()}`;
  }
  const hours = String(atDate.getHours()).padStart(2, '0');
  const minutes = String(atDate.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function GROUP_SESSION_TITLE(name: string): string {
  return `Group: ${name}`;
}

export function validateGroup({ name, memberIds }: { name: string; memberIds: string[] }): { ok: boolean; error?: string } {
  if (!name.trim()) return { ok: false, error: 'name required' };
  const unique = [...new Set(memberIds)];
  if (unique.length < MIN_GROUP_MEMBERS) return { ok: false, error: 'need at least 2 bots' };
  if (unique.length > MAX_GROUP_MEMBERS) return { ok: false, error: 'at most 6 bots' };
  return { ok: true };
}

/**
 * Mirror of the Gate's planGroupRounds (gate/core/cli-environments/
 * bot-groups.mjs) kept for pure tests and UI scoping. Defaults must match
 * what a phone send actually runs: ONE round over the active set, with the
 * Gate's own message-count guard as an upper bound for callers that ask for
 * more rounds.
 */
export function planGroupRounds({
  memberIds,
  mentionedIds = [],
  maxRounds = GROUP_ROUNDS_ON_SEND,
  maxMessages = MAX_GROUP_MESSAGES,
}: {
  memberIds: string[];
  mentionedIds?: string[];
  maxRounds?: number;
  maxMessages?: number;
}): { botId: string }[] {
  const mentioned = mentionedIds.filter((id) => memberIds.includes(id));
  const active = mentioned.length > 0 ? mentioned : memberIds;
  const steps: { botId: string }[] = [];
  for (let round = 0; round < maxRounds && steps.length < maxMessages; round += 1) {
    for (const botId of active) {
      if (steps.length >= maxMessages) break;
      steps.push({ botId });
    }
  }
  return steps;
}

/**
 * Who actually speaks on a send: @mentioned members when there are any,
 * otherwise the whole room. Mirrors planGroupRounds' active-set rule so UI
 * copy cannot drift from what the Gate will run.
 */
export function groupSpeakers(memberIds: string[], mentionedIds: string[] = []): string[] {
  const mentioned = mentionedIds.filter((id) => memberIds.includes(id));
  return mentioned.length > 0 ? mentioned : memberIds;
}

/**
 * The one-line contract shown above the composer: how many bots speak on a
 * send. Derived from the same planner default as the Gate runs, never
 * hand-copied numbers. ONE round: the Gate's deliverGroupMessage plans a
 * single round for a phone send (maxRounds default), so the line says what
 * the wire will do and never promises a multi-round exchange or a message
 * cap that cannot bind on a six-member room.
 */
export function describeGroupPlan(speakerCount: number): string {
  const noun = speakerCount === 1 ? 'bot speaks' : 'bots speak';
  return `${speakerCount} ${noun} · one round`;
}

function joinAnd(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The honest variant of the plan line: a member that cannot route is not a
 * speaker, and neither is one the phone has never seen on the loaded roster
 * ('not on this gateway') — only roster-confirmed routable members count.
 * When the inventory itself never loaded (rosterLoaded false) the line names
 * the unread roster instead of asserting round counts the phone cannot
 * prove. Every speaker routable (or reporting nothing — older Gates) makes
 * this exactly describeGroupPlan. Silent members are named so the operator
 * reads the cause before sending, and the round fact never moves.
 */
export function describeRoomPlan({
  speakerCount,
  routableCount,
  silentNames,
  unknownNames = [],
  rosterLoaded = true,
}: {
  speakerCount: number;
  routableCount: number;
  silentNames: string[];
  unknownNames?: string[];
  rosterLoaded?: boolean;
}): string {
  const rounds = `one round`;
  if (!rosterLoaded) return `Roster not loaded — routing unverified · ${rounds}`;
  const silent = silentNames.filter((name) => typeof name === 'string' && name.trim());
  const unknown = unknownNames.filter((name) => typeof name === 'string' && name.trim());
  if (routableCount >= Math.max(speakerCount, 0) && unknown.length === 0) return describeGroupPlan(speakerCount);
  const clauses: string[] = [];
  // The legacy drift fallback ('a member cannot route') fires only when no
  // unknown member explains the count shortfall — a named cause is better.
  if (silent.length > 0 || (unknown.length === 0 && routableCount < Math.max(speakerCount, 0))) {
    clauses.push(`${joinAnd(silent.length ? silent : ['a member'])} cannot route`);
  }
  if (unknown.length > 0) clauses.push(`${joinAnd(unknown)} not on this gateway`);
  const causes = clauses.join(' · ');
  if (routableCount <= 0) return `Nothing will speak — ${causes} · ${rounds}`;
  return `${routableCount} of ${speakerCount} bots speak · ${causes} · ${rounds}`;
}

/**
 * The honest outcome line under a sent message: how many replies came back,
 * or — when none did — WHY. A zero-reply round only blames choice when every
 * scoped speaker could actually route; structural silence names who could
 * not, members missing from the loaded roster are named as unknown rather
 * than blamed, and a roster that never loaded is named itself (no routing
 * verdict can be drawn from an inventory the phone never read). Counts are
 * the SEND-time scope, not the live draft.
 *
 * Partial silence is a WIRE fact, not an inference: the Gate's one-round plan
 * asks every scoped speaker exactly once and returns the audible replies, so
 * on a successful send `speakerCount - replyCount` is exactly how many asked
 * bots stayed quiet. The outcome line says so instead of hiding the early
 * round behind a bare reply count.
 */
export function describeRoundOutcome({
  replyCount,
  speakerCount,
  routableCount,
  silentNames,
  unknownNames = [],
  rosterLoaded = true,
}: {
  replyCount: number;
  speakerCount: number;
  routableCount: number;
  silentNames: string[];
  unknownNames?: string[];
  rosterLoaded?: boolean;
}): string {
  if (replyCount > 0) {
    // Replies that landed are real whatever the inventory said — count them.
    // A successful send asked every scoped speaker once (the Gate's one-round
    // plan), so anything short of the full scope was asked and stayed quiet.
    // Missing scope fields (future writer drift) degrade to the legacy
    // bare-count reading instead of inventing a silence verdict.
    if (speakerCount > 0 && replyCount < speakerCount) {
      const silent = speakerCount - replyCount;
      return `${replyCount} of ${speakerCount} asked answered · ${silent} ${silent === 1 ? 'bot' : 'bots'} stayed silent`;
    }
    return `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'} this round`;
  }
  if (!rosterLoaded) return 'No replies — the roster never loaded, so routing was never verified.';
  const silent = silentNames.filter((name) => typeof name === 'string' && name.trim());
  const unknown = unknownNames.filter((name) => typeof name === 'string' && name.trim());
  if (unknown.length > 0) {
    const parts = [`No replies — ${joinAnd(unknown)} not on this gateway`];
    if (silent.length > 0) parts.push(`${joinAnd(silent)} cannot route`);
    if (routableCount > 0) parts.push('the rest stayed silent');
    return `${parts.join(' · ')}.`;
  }
  if (routableCount < Math.max(speakerCount, 0)) {
    const names = silent.length ? silent : ['a member'];
    const who = `${joinAnd(names)} cannot route`;
    if (routableCount <= 0) return `No replies — ${who}.`;
    return `No replies — ${who} · the rest stayed silent.`;
  }
  return 'No replies — every bot stayed silent.';
}

/**
 * Whether the phone holds VERIFIED bot-inventory knowledge: a completed,
 * error-free roster read, or rows that survived from an earlier success.
 * A FAILED read verifies nothing even though it is no longer loading —
 * its wiped roster must not let plan/outcome lines assert routing
 * verdicts from zero knowledge (the fake-verdict class B19 exists to
 * kill; rook 2026-08-24T20:51). Zero bots from a CLEAN read is still
 * verified: an empty gateway is a fact, not a gap.
 */
export function rosterInventoryVerified({
  loading,
  error,
  botCount,
}: {
  loading: boolean;
  error?: string;
  botCount: number;
}): boolean {
  return (!loading && !error) || botCount > 0;
}

/** Roster subtitle for a group row. */
export function groupMemberLine(group: Pick<BotGroupRoom, 'memberIds'>): string {
  const count = group.memberIds.length;
  return `${count} member${count === 1 ? '' : 's'}`;
}

/**
 * Roster long-press sheet facts for one room: every member id resolved
 * through the loaded bot inventory, and how many had no name on it. A
 * member the phone has never seen on the roster shows its raw id rather
 * than an invented name — the roster copy is the ONLY name source, and
 * `unknown` lets the sheet say "n not on this gateway" out loud, the same
 * honesty rule as the room view's routing chips.
 */
export function roomMemberNames(
  group: Pick<BotGroupRoom, 'memberIds'>,
  namesById: ReadonlyMap<string, string>,
): { names: string[]; unknown: number } {
  const names: string[] = [];
  let unknown = 0;
  for (const memberId of group.memberIds) {
    const name = namesById.get(memberId);
    if (typeof name === 'string' && name.length > 0) {
      names.push(name);
    } else {
      names.push(memberId);
      unknown += 1;
    }
  }
  return { names, unknown };
}

/**
 * A member may be removed while the room stays viable. At the two-member
 * floor every remaining member is structural — refuse with the reason.
 */
export function canRemoveMember(group: Pick<BotGroupRoom, 'memberIds'>): boolean {
  return group.memberIds.length > MIN_GROUP_MEMBERS;
}

export const GROUP_MEMBER_FLOOR_REASON = `A room needs at least ${MIN_GROUP_MEMBERS} members`;

/** Whether the room can take even one more member (six-member ceiling). */
export function canAddMember(group: Pick<BotGroupRoom, 'memberIds'>): boolean {
  return group.memberIds.length < MAX_GROUP_MEMBERS;
}

/**
 * Who a room can still take: the loaded inventory's routable bots that are
 * not already members — the same eligibility the create-room chips follow,
 * minus the current roster. Order follows the caller's list (the phone
 * renders roster order, not set order).
 */
export function addableMembers<T extends { id: string; routable?: boolean }>(
  group: Pick<BotGroupRoom, 'memberIds'>,
  bots: readonly T[],
): T[] {
  const members = new Set(group.memberIds);
  return bots.filter((bot) => Boolean(bot.routable) && !members.has(bot.id));
}

/** One remove-picker option: a current member and its roster-resolved label. */
export type RemovableMemberOption = {
  id: string;
  /** Display name when the loaded inventory knows this member, else raw id. */
  label: string;
  /** True when the inventory had no name — the chip shows the raw id. */
  unknown: boolean;
};

/**
 * Who the remove picker offers: every current member, in room order, labeled
 * through the loaded bot inventory (raw id when never seen — never an
 * invented name, the same rule as the sheet's member line). Empty at the
 * two-member floor: every remaining member is structural, so there is
 * nothing honest to offer.
 */
export function removableMembers(
  group: Pick<BotGroupRoom, 'memberIds'>,
  namesById: ReadonlyMap<string, string>,
): RemovableMemberOption[] {
  if (!canRemoveMember(group)) return [];
  return group.memberIds.map((id) => {
    const name = namesById.get(id);
    const known = typeof name === 'string' && name.length > 0;
    return { id, label: known ? (name as string) : id, unknown: !known };
  });
}

/**
 * Room search over name, id, and member ids. A blank query is "no filter".
 */
export function filterGroupRooms(rooms: BotGroupRoom[], query: string): BotGroupRoom[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rooms;
  return rooms.filter((room) =>
    [room.name, room.id, ...room.memberIds].some(
      (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
    ));
}

/**
 * What the probe looks for on a client surface: a manifest client's own word
 * (`canManageGroups`) about whether its document advertises botGroups, or
 * failing that, the rooms-dialect call itself. Loosely typed on purpose —
 * adapters are probed structurally, not by importing portal types.
 */
export type GroupRoomSurface = {
  canManageGroups?: unknown;
  createGroup?: unknown;
};

/**
 * Can this gateway host Gate-owned group rooms? Decided BEFORE the operator
 * names a room and picks members: adapters without the rooms dialect omit
 * createGroup entirely, and a manifest client whose document declares no
 * botGroups endpoint says so through canManageGroups — so the roster hides
 * "New Group Room" instead of refusing after the sheet is filled.
 */
export function hasGroupRooms(client?: object | null): boolean {
  if (!client) return false;
  const surface = client as GroupRoomSurface;
  if (typeof surface.canManageGroups === 'boolean') return surface.canManageGroups;
  return typeof surface.createGroup === 'function';
}

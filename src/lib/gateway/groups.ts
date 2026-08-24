export const MAX_GROUP_MEMBERS = 6;
export const MIN_GROUP_MEMBERS = 2;
export const MAX_GROUP_ROUNDS = 3;
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

export function planGroupRounds({
  memberIds,
  mentionedIds = [],
  maxRounds = MAX_GROUP_ROUNDS,
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
 * The one-line contract shown above the composer: how many bots speak per
 * round and where the caps bite. Derived from the same constants as the
 * planner, never hand-copied numbers.
 */
export function describeGroupPlan(speakerCount: number): string {
  const noun = speakerCount === 1 ? 'bot speaks' : 'bots speak';
  return `${speakerCount} ${noun} per round · up to ${MAX_GROUP_ROUNDS} rounds · stops at ${MAX_GROUP_MESSAGES} messages`;
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
 * reads the cause before sending, and the caps segment never moves.
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
  const caps = `up to ${MAX_GROUP_ROUNDS} rounds · stops at ${MAX_GROUP_MESSAGES} messages`;
  if (!rosterLoaded) return `Roster not loaded — routing unverified · ${caps}`;
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
  if (routableCount <= 0) return `Nothing will speak — ${causes} · ${caps}`;
  return `${routableCount} of ${speakerCount} bots speak per round · ${causes} · ${caps}`;
}

/**
 * The honest outcome line under a sent message: how many replies came back,
 * or — when none did — WHY. A zero-reply round only blames choice when every
 * scoped speaker could actually route; structural silence names who could
 * not, members missing from the loaded roster are named as unknown rather
 * than blamed, and a roster that never loaded is named itself (no routing
 * verdict can be drawn from an inventory the phone never read). Counts are
 * the SEND-time scope, not the live draft.
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

/** Roster subtitle for a group row. */
export function groupMemberLine(group: Pick<BotGroupRoom, 'memberIds'>): string {
  const count = group.memberIds.length;
  return `${count} member${count === 1 ? '' : 's'}`;
}

/**
 * A member may be removed while the room stays viable. At the two-member
 * floor every remaining member is structural — refuse with the reason.
 */
export function canRemoveMember(group: Pick<BotGroupRoom, 'memberIds'>): boolean {
  return group.memberIds.length > MIN_GROUP_MEMBERS;
}

export const GROUP_MEMBER_FLOOR_REASON = `A room needs at least ${MIN_GROUP_MEMBERS} members`;

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

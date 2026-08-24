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

/** What the room view renders for one transcript line. */
export type RoomTranscriptRow =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'bot'; botId: string; text: string };

/**
 * Fold stored transcript lines into room rows, oldest-first as stored. Rows
 * the view cannot render honestly (unknown roles, bot lines without an
 * author) are dropped rather than drawn broken.
 */
export function transcriptToRoomEntries(entries: GroupTranscriptEntry[]): RoomTranscriptRow[] {
  const rows: RoomTranscriptRow[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string') continue;
    if (entry.role === 'user') {
      rows.push({ id: entry.id, role: 'user', text: entry.text });
    } else if (entry.role === 'bot' && typeof entry.botId === 'string') {
      rows.push({ id: entry.id, role: 'bot', botId: entry.botId, text: entry.text });
    }
  }
  return rows;
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

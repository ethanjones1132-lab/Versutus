import {
  canRemoveMember,
  describeGroupPlan,
  describeRoomPlan,
  filterGroupRooms,
  formatGroupMessageTime,
  GROUP_MEMBER_FLOOR_REASON,
  GROUP_SESSION_TITLE,
  groupMemberLine,
  groupSpeakers,
  MAX_GROUP_MESSAGES,
  MAX_GROUP_ROUNDS,
  planGroupRounds,
  transcriptToRoomEntries,
  validateGroup,
} from '@/lib/gateway/groups';
import type { BotGroupRoom, GroupTranscriptEntry } from '@/lib/gateway/groups';

const ROOM: BotGroupRoom = { id: 'room1', name: 'crew', memberIds: ['coder', 'researcher'] };

test('validateGroup enforces 2–6 members', () => {
  expect(validateGroup({ name: 'crew', memberIds: ['a'] }).ok).toBe(false);
  expect(validateGroup({ name: 'crew', memberIds: ['a', 'b'] }).ok).toBe(true);
  expect(validateGroup({ name: 'crew', memberIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).ok).toBe(false);
});

test('planGroupRounds mentions subset and caps at 10', () => {
  const planned = planGroupRounds({
    memberIds: ['coder', 'researcher', 'writer'],
    mentionedIds: ['researcher'],
  });
  expect(planned.every((step) => step.botId === 'researcher')).toBe(true);
  expect(planned.length).toBeLessThanOrEqual(10);
  expect(GROUP_SESSION_TITLE('crew')).toBe('Group: crew');
});

test('groupSpeakers mirrors the planner active-set rule', () => {
  // Mentions scope the round to members actually in the room…
  expect(groupSpeakers(ROOM.memberIds, ['researcher'])).toEqual(['researcher']);
  // …a mention of a non-member cannot smuggle an outsider in…
  expect(groupSpeakers(ROOM.memberIds, ['stranger'])).toEqual(ROOM.memberIds);
  // …and no mention means the whole room speaks.
  expect(groupSpeakers(ROOM.memberIds)).toEqual(ROOM.memberIds);
});

test('describeGroupPlan is derived from the planner constants, not hand-copied numbers', () => {
  const line = describeGroupPlan(3);
  expect(line).toContain('3 bots speak per round');
  expect(line).toContain(`up to ${MAX_GROUP_ROUNDS} rounds`);
  expect(line).toContain(`stops at ${MAX_GROUP_MESSAGES} messages`);
  expect(describeGroupPlan(1)).toContain('1 bot speaks per round');
});

test('describeRoomPlan stops counting unroutable members as speakers', () => {
  // Everyone routable (or an older Gate reporting nothing): the classic line.
  expect(describeRoomPlan({ speakerCount: 3, routableCount: 3, silentNames: [] })).toBe(
    describeGroupPlan(3),
  );
  // One silent member: the count drops and the cause is named, caps intact.
  const partial = describeRoomPlan({ speakerCount: 3, routableCount: 2, silentNames: ['Echo'] });
  expect(partial).toContain('2 of 3 bots speak per round');
  expect(partial).toContain('Echo cannot route');
  expect(partial).toContain(`up to ${MAX_GROUP_ROUNDS} rounds`);
  expect(partial).toContain(`stops at ${MAX_GROUP_MESSAGES} messages`);
  // Several silent members fold into one clause.
  expect(
    describeRoomPlan({ speakerCount: 4, routableCount: 2, silentNames: ['Echo', 'Foxtrot'] }),
  ).toContain('Echo and Foxtrot cannot route');
  expect(
    describeRoomPlan({ speakerCount: 5, routableCount: 2, silentNames: ['Echo', 'Foxtrot', 'Golf'] }),
  ).toContain('Echo, Foxtrot and Golf cannot route');
  // A round where nobody can route says so instead of promising replies.
  const dead = describeRoomPlan({ speakerCount: 2, routableCount: 0, silentNames: ['Echo', 'Foxtrot'] });
  expect(dead).toContain('Nothing will speak');
  expect(dead).toContain('Echo and Foxtrot cannot route');
  // Caller drift (counts without names) still reads like a sentence.
  expect(describeRoomPlan({ speakerCount: 3, routableCount: 1, silentNames: [] })).toContain(
    'a member cannot route',
  );
});

test('roster copy helpers stay honest about size and search', () => {
  expect(groupMemberLine(ROOM)).toBe('2 members');
  expect(groupMemberLine({ ...ROOM, memberIds: ['solo'] })).toBe('1 member');

  expect(canRemoveMember({ memberIds: ['a', 'b', 'c'] })).toBe(true);
  expect(canRemoveMember(ROOM)).toBe(false);
  expect(GROUP_MEMBER_FLOOR_REASON).toContain('at least 2 members');

  const rooms = [ROOM, { id: 'r2', name: 'Bridge Crew', memberIds: ['a', 'b'] }];
  expect(filterGroupRooms(rooms, '')).toHaveLength(2);
  expect(filterGroupRooms(rooms, 'bridge').map((room) => room.id)).toEqual(['r2']);
  // Member ids are searchable too — operators think in handles.
  expect(filterGroupRooms(rooms, 'researcher').map((room) => room.id)).toEqual(['room1']);
  expect(filterGroupRooms(rooms, 'zzz')).toEqual([]);
});

test('transcriptToRoomEntries folds stored history into renderable rows, oldest-first', () => {
  // Wire order from the Gate: operator line first, then each reply of the send.
  const stored: GroupTranscriptEntry[] = [
    { id: 'a1', role: 'user', text: 'plan the launch', at: 1 },
    { id: 'a2', role: 'bot', botId: 'coder', text: 'on it', at: 1 },
    { id: 'a3', role: 'bot', text: 'no author — dropped' },
    { id: 'a4', role: 'mystery', text: '?' } as unknown as GroupTranscriptEntry,
    { id: 'a5', role: 'user', text: '' },
    { id: 'a6', role: 'bot', botId: 'writer', text: 'corrupt stamp dropped', at: 'nope' } as unknown as GroupTranscriptEntry,
    null as unknown as GroupTranscriptEntry,
  ];

  expect(transcriptToRoomEntries(stored)).toEqual([
    { id: 'a1', role: 'user', text: 'plan the launch', at: 1 },
    { id: 'a2', role: 'bot', botId: 'coder', text: 'on it', at: 1 },
    // An empty line is still history — kept.
    { id: 'a5', role: 'user', text: '' },
    // A non-numeric stamp never reaches the UI as garbage…
    { id: 'a6', role: 'bot', botId: 'writer', text: 'corrupt stamp dropped' },
  ]);

  // A gate without transcripts answers empty; the fold of nothing is nothing.
  expect(transcriptToRoomEntries([])).toEqual([]);
});

test('formatGroupMessageTime renders clock time today and a short date older', () => {
  const now = new Date(2026, 7, 24, 15, 30).getTime(); // Aug 24 2026, local
  // Today's lines are clock time, zero-padded.
  expect(formatGroupMessageTime(new Date(2026, 7, 24, 14, 2).getTime(), now)).toBe('14:02');
  expect(formatGroupMessageTime(new Date(2026, 7, 24, 9, 5).getTime(), now)).toBe('09:05');
  expect(formatGroupMessageTime(new Date(2026, 7, 24, 0, 0).getTime(), now)).toBe('00:00');
  // One minute before the rollover already reads as a date — day boundaries,
  // not "24h ago", decide the form.
  expect(formatGroupMessageTime(new Date(2026, 7, 23, 23, 59).getTime(), now)).toBe('Aug 23');
  // Same calendar day in a previous year stays the date form.
  expect(formatGroupMessageTime(new Date(2025, 7, 24, 10, 0).getTime(), now)).toBe('Aug 24');
  // Unrenderable stamps degrade to '' so the view skips the line entirely.
  expect(formatGroupMessageTime(Number.NaN, now)).toBe('');
  expect(formatGroupMessageTime(Number.POSITIVE_INFINITY, now)).toBe('');
});

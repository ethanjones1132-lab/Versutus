import {
  canRemoveMember,
  describeGroupPlan,
  describeRoomPlan,
  describeRoundOutcome,
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

test('describeRoundOutcome never blames choice when routing was impossible', () => {
  // Replies came back: the plain count line, byte-for-byte as before.
  expect(describeRoundOutcome({ replyCount: 1, speakerCount: 2, routableCount: 2, silentNames: [] })).toBe(
    '1 reply this round',
  );
  expect(describeRoundOutcome({ replyCount: 3, speakerCount: 3, routableCount: 3, silentNames: [] })).toBe(
    '3 replies this round',
  );
  // Every scoped speaker could route and none answered: NOW choice is the story.
  expect(describeRoundOutcome({ replyCount: 0, speakerCount: 2, routableCount: 2, silentNames: [] })).toBe(
    'No replies — every bot stayed silent.',
  );
  // Nobody could route: the silence was structural, not a choice.
  expect(describeRoundOutcome({ replyCount: 0, speakerCount: 2, routableCount: 0, silentNames: ['Echo'] })).toBe(
    'No replies — Echo cannot route.',
  );
  expect(
    describeRoundOutcome({ replyCount: 0, speakerCount: 3, routableCount: 0, silentNames: ['Echo', 'Foxtrot'] }),
  ).toBe('No replies — Echo and Foxtrot cannot route.');
  // Mixed: naming routing alone would slander the bots that simply chose quiet.
  expect(describeRoundOutcome({ replyCount: 0, speakerCount: 3, routableCount: 2, silentNames: ['Echo'] })).toBe(
    'No replies — Echo cannot route · the rest stayed silent.',
  );
  // Caller drift (counts say someone unroutable existed but the name is lost)
  // still reads like a sentence instead of blaming choice.
  expect(describeRoundOutcome({ replyCount: 0, speakerCount: 3, routableCount: 1, silentNames: [] })).toContain(
    'a member cannot route',
  );
});

test('describeRoomPlan counts only roster-confirmed speakers', () => {
  // A member the phone has never seen on the loaded inventory is not a
  // speaker: the count drops and the member says it is missing.
  const partial = describeRoomPlan({
    speakerCount: 3,
    routableCount: 2,
    silentNames: [],
    unknownNames: ['Ghost'],
  });
  expect(partial).toContain('2 of 3 bots speak per round');
  expect(partial).toContain('Ghost not on this gateway');
  expect(partial).toContain(`up to ${MAX_GROUP_ROUNDS} rounds`);
  expect(partial).toContain(`stops at ${MAX_GROUP_MESSAGES} messages`);
  // Missing AND confirmed-unroutable members: both causes are named in order.
  const mixed = describeRoomPlan({
    speakerCount: 4,
    routableCount: 1,
    silentNames: ['Echo'],
    unknownNames: ['Foxtrot', 'Ghost'],
  });
  expect(mixed).toContain('1 of 4 bots speak per round');
  expect(mixed).toContain('Echo cannot route');
  expect(mixed).toContain('Foxtrot and Ghost not on this gateway');
  // Nobody verified can speak: no promise of replies.
  const dead = describeRoomPlan({
    speakerCount: 2,
    routableCount: 0,
    silentNames: [],
    unknownNames: ['Ghost'],
  });
  expect(dead).toContain('Nothing will speak');
  expect(dead).toContain('Ghost not on this gateway');
  // Omitted unknowns keep the legacy line byte-for-byte.
  expect(describeRoomPlan({ speakerCount: 3, routableCount: 3, silentNames: [] })).toBe(describeGroupPlan(3));
});

test('describeRoomPlan names an unread roster instead of asserting round counts', () => {
  const unverified = describeRoomPlan({
    speakerCount: 3,
    routableCount: 3,
    silentNames: [],
    rosterLoaded: false,
  });
  expect(unverified).toContain('Roster not loaded');
  expect(unverified).toContain('routing unverified');
  expect(unverified).not.toContain('speak per round');
  expect(unverified).toContain(`up to ${MAX_GROUP_ROUNDS} rounds`);
  expect(unverified).toContain(`stops at ${MAX_GROUP_MESSAGES} messages`);
});

test('describeRoundOutcome never blames choice when the roster never loaded', () => {
  expect(
    describeRoundOutcome({ replyCount: 0, speakerCount: 2, routableCount: 2, silentNames: [], rosterLoaded: false }),
  ).toBe('No replies — the roster never loaded, so routing was never verified.');
  // Replies that DID land are real whatever the inventory said — they count.
  expect(
    describeRoundOutcome({ replyCount: 2, speakerCount: 2, routableCount: 2, silentNames: [], rosterLoaded: false }),
  ).toBe('2 replies this round');
});

test('describeRoundOutcome names roster-missing members instead of blaming choice', () => {
  // All speakers missing from the inventory: structural, not a choice.
  expect(
    describeRoundOutcome({ replyCount: 0, speakerCount: 2, routableCount: 0, silentNames: [], unknownNames: ['Ghost'] }),
  ).toBe('No replies — Ghost not on this gateway.');
  // Missing AND confirmed-unroutable: both structural causes, then the
  // routable survivors' silence is still called out.
  expect(
    describeRoundOutcome({
      replyCount: 0,
      speakerCount: 3,
      routableCount: 1,
      silentNames: ['Echo'],
      unknownNames: ['Ghost'],
    }),
  ).toBe('No replies — Ghost not on this gateway · Echo cannot route · the rest stayed silent.');
  // Missing members alongside confirmed-routable ones who chose silence.
  expect(
    describeRoundOutcome({
      replyCount: 0,
      speakerCount: 3,
      routableCount: 1,
      silentNames: [],
      unknownNames: ['Ghost', 'Foxtrot'],
    }),
  ).toBe('No replies — Ghost and Foxtrot not on this gateway · the rest stayed silent.');
  // Junk unknown names degrade to the legacy reading rather than inventing
  // a missing member.
  expect(
    describeRoundOutcome({
      replyCount: 0,
      speakerCount: 3,
      routableCount: 1,
      silentNames: [],
      unknownNames: ['', '   '],
    }),
  ).toContain('a member cannot route');
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

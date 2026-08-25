import {
  addableMembers,
  canAddMember,
  canRemoveMember,
  describeGroupPlan,
  describeRoomPlan,
  describeRoundOutcome,
  filterGroupRooms,
  formatGroupMessageTime,
  GROUP_MEMBER_FLOOR_REASON,
  GROUP_ROUNDS_ON_SEND,
  GROUP_SESSION_TITLE,
  groupMemberLine,
  groupSpeakers,
  MAX_GROUP_MESSAGES,
  mergeTranscriptRows,
  planGroupRounds,
  removableMembers,
  roomMemberNames,
  rosterInventoryVerified,
  TRANSCRIPT_DEDUPE_WINDOW_MS,
  transcriptToRoomEntries,
  validateGroup,
} from '@/lib/gateway/groups';
import type { BotGroupRoom, GroupTranscriptEntry, TranscriptRowLike } from '@/lib/gateway/groups';

const ROOM: BotGroupRoom = { id: 'room1', name: 'crew', memberIds: ['coder', 'researcher'] };

test('validateGroup enforces 2–6 members', () => {
  expect(validateGroup({ name: 'crew', memberIds: ['a'] }).ok).toBe(false);
  expect(validateGroup({ name: 'crew', memberIds: ['a', 'b'] }).ok).toBe(true);
  expect(validateGroup({ name: 'crew', memberIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).ok).toBe(false);
});

test('planGroupRounds defaults to ONE round (the Gate\'s wire plan)', () => {
  const planned = planGroupRounds({
    memberIds: ['coder', 'researcher', 'writer'],
    mentionedIds: ['researcher'],
  });
  // The phone send runs a single round: the mention subset, once each.
  expect(planned.map((step) => step.botId)).toEqual(['researcher']);
  expect(planned.length).toBe(1);
  // The ONE-round default is the same constant the plan copy quotes.
  expect(GROUP_ROUNDS_ON_SEND).toBe(1);
  expect(GROUP_SESSION_TITLE('crew')).toBe('Group: crew');
});

test('planGroupRounds multi-round callers still stop at the Gate message guard', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];
  const planned = planGroupRounds({ memberIds: six, maxRounds: 3 });
  expect(planned.length).toBe(MAX_GROUP_MESSAGES);
  // Round boundaries are positional in the mirror: round two starts at
  // index 6, so the first six steps are the room once and the seventh is
  // the first member again.
  expect(planned.slice(0, 6).map((step) => step.botId)).toEqual(six);
  expect(planned[6].botId).toBe('a');
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
  expect(line).toContain('3 bots speak');
  expect(line).toContain('one round');
  expect(describeGroupPlan(1)).toContain('1 bot speaks');
  // The plan line tells what the wire runs: ONE round, never a multi-round
  // promise or a message cap that cannot bind a six-member send.
  expect(line).not.toContain('rounds');
  expect(line).not.toContain('stops at');
  expect(line).not.toContain('cap');
});

test('describeRoomPlan stops counting unroutable members as speakers', () => {
  // Everyone routable (or an older Gate reporting nothing): the classic line.
  expect(describeRoomPlan({ speakerCount: 3, routableCount: 3, silentNames: [] })).toBe(
    describeGroupPlan(3),
  );
  // One silent member: the count drops and the cause is named, round fact intact.
  const partial = describeRoomPlan({ speakerCount: 3, routableCount: 2, silentNames: ['Echo'] });
  expect(partial).toContain('2 of 3 bots speak');
  expect(partial).toContain('Echo cannot route');
  expect(partial).toContain('one round');
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
  expect(dead).toContain('one round');
  // Caller drift (counts without names) still reads like a sentence.
  expect(describeRoomPlan({ speakerCount: 3, routableCount: 1, silentNames: [] })).toContain(
    'a member cannot route',
  );
});

test('describeRoundOutcome never blames choice when routing was impossible', () => {
  // Replies came back short of the asked scope: the early round is named,
  // not hidden behind a bare count.
  expect(describeRoundOutcome({ replyCount: 1, speakerCount: 2, routableCount: 2, silentNames: [] })).toBe(
    '1 of 2 asked answered · 1 bot stayed silent',
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

test('describeRoundOutcome names the silence when a round ends early', () => {
  // Every scoped speaker asked, some stayed quiet: the wire-provable gap
  // between the send scope and the replies is surfaced, never hidden.
  expect(
    describeRoundOutcome({ replyCount: 2, speakerCount: 5, routableCount: 5, silentNames: [] }),
  ).toBe('2 of 5 asked answered · 3 bots stayed silent');
  expect(
    describeRoundOutcome({ replyCount: 1, speakerCount: 4, routableCount: 4, silentNames: [] }),
  ).toBe('1 of 4 asked answered · 3 bots stayed silent');
  // Singular silence reads as a sentence.
  expect(
    describeRoundOutcome({ replyCount: 2, speakerCount: 3, routableCount: 3, silentNames: [] }),
  ).toBe('2 of 3 asked answered · 1 bot stayed silent');
  // Full scope answered: the legacy bare count, byte-for-byte.
  expect(
    describeRoundOutcome({ replyCount: 4, speakerCount: 4, routableCount: 4, silentNames: [] }),
  ).toBe('4 replies this round');
  // A reply count that drifts ABOVE the recorded scope (stale send-time
  // field) never fabricates a negative silence count — replies are real.
  expect(
    describeRoundOutcome({ replyCount: 3, speakerCount: 2, routableCount: 2, silentNames: [] }),
  ).toBe('3 replies this round');
  // Missing scope fields degrade to the bare count, not an invented verdict.
  expect(describeRoundOutcome({ replyCount: 1, speakerCount: 0, routableCount: 0, silentNames: [] })).toBe(
    '1 reply this round',
  );
  // The invented cap note is gone: nothing claims the plan stopped at a
  // message limit the wire never reported.
  expect(describeRoundOutcome({ replyCount: 10, speakerCount: 10, routableCount: 10, silentNames: [] })).toBe(
    '10 replies this round',
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
  expect(partial).toContain('2 of 3 bots speak');
  expect(partial).toContain('Ghost not on this gateway');
  expect(partial).toContain('one round');
  // Missing AND confirmed-unroutable members: both causes are named in order.
  const mixed = describeRoomPlan({
    speakerCount: 4,
    routableCount: 1,
    silentNames: ['Echo'],
    unknownNames: ['Foxtrot', 'Ghost'],
  });
  expect(mixed).toContain('1 of 4 bots speak');
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
  expect(unverified).not.toContain('speak');
  expect(unverified).toContain('one round');
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

test('roomMemberNames resolves names from the loaded roster copy and names nothing it lacks', () => {
  const byId = new Map([
    ['coder', 'Coder'],
    ['researcher', 'Researcher'],
  ]);
  expect(roomMemberNames(ROOM, byId)).toEqual({ names: ['Coder', 'Researcher'], unknown: 0 });
});

test('roomMemberNames falls back to the raw id and counts a member never seen on the roster', () => {
  // A member missing from the loaded inventory has no verified name — the
  // sheet must show the raw id and say how many are unverified, never
  // invent a display name (same honesty rule as the room view's chips).
  const byId = new Map([['coder', 'Coder']]);
  expect(roomMemberNames(ROOM, byId)).toEqual({ names: ['Coder', 'researcher'], unknown: 1 });
});

test('roomMemberNames handles an empty room and an empty inventory', () => {
  expect(roomMemberNames({ memberIds: [] }, new Map())).toEqual({ names: [], unknown: 0 });
  expect(roomMemberNames(ROOM, new Map())).toEqual({ names: ['coder', 'researcher'], unknown: 2 });
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

test('rosterInventoryVerified: a FAILED first read is not loaded, even though its spinner stopped', () => {
  // The exact lie rook 2026-08-24T20:51 flagged: the load-failure path wipes
  // the roster and stops the spinner, so `!loading || count > 0` read TRUE
  // from zero knowledge and the room asserted verdicts it could not prove.
  expect(rosterInventoryVerified({ loading: false, error: 'HTTP 500', botCount: 0 })).toBe(false);
});

test('rosterInventoryVerified: a completed clean read verifies even at zero bots', () => {
  // An empty gateway is a fact, not a gap — a clean read with no rows is proof.
  expect(rosterInventoryVerified({ loading: false, error: undefined, botCount: 0 })).toBe(true);
});

test('rosterInventoryVerified: an in-flight first read stays unverified', () => {
  expect(rosterInventoryVerified({ loading: true, error: undefined, botCount: 0 })).toBe(false);
});

test('rosterInventoryVerified: rows surviving an earlier success keep verdicts provable after a failed refresh', () => {
  expect(rosterInventoryVerified({ loading: false, error: 'timeout', botCount: 3 })).toBe(true);
});

const NOW = 1_752_000_000_000;

test('mergeTranscriptRows folds new stored lines in oldest-first, before the live rows', () => {
  const current = [{ id: 'u-1', role: 'user', text: 'go', at: NOW } as const];
  const stored: GroupTranscriptEntry[] = [
    { id: 'g-1', role: 'user', text: 'earlier exchange', at: NOW - 60_000 },
    { id: 'g-2', role: 'bot', botId: 'coder', text: 'done', at: NOW - 60_000 },
  ];
  expect(mergeTranscriptRows(current, stored)).toEqual([
    { id: 'g-1', role: 'user', text: 'earlier exchange', at: NOW - 60_000 },
    { id: 'g-2', role: 'bot', botId: 'coder', text: 'done', at: NOW - 60_000 },
    { id: 'u-1', role: 'user', text: 'go', at: NOW },
  ]);
});

test('mergeTranscriptRows keeps reading order when a re-read brings lines NEWER than the view (pull-to-refresh)', () => {
  const current = [{ id: 'g-1', role: 'user', text: 'seen', at: NOW } as const];
  // The Gate returns the same line again (deduped) plus a line another device
  // sent after this phone's last read. The newer line must land BELOW the
  // older conversation at the reading position — prepending it put the newest
  // message at the top of the transcript (rook 2026-08-25).
  const stored: GroupTranscriptEntry[] = [
    { id: 'g-1', role: 'user', text: 'seen', at: NOW },
    { id: 'g-2', role: 'bot', botId: 'writer', text: 'fresh', at: NOW + 5_000 },
  ];
  expect(mergeTranscriptRows(current, stored)).toEqual([
    { id: 'g-1', role: 'user', text: 'seen', at: NOW },
    { id: 'g-2', role: 'bot', botId: 'writer', text: 'fresh', at: NOW + 5_000 },
  ]);
});

test('mergeTranscriptRows interleaves older and newer additions chronologically, not by read order', () => {
  const current = [{ id: 'u-1', role: 'user', text: 'go', at: NOW } as const];
  // One stored line predates the whole view (first replay), the other
  // postdates it (another device answered since the last read). The merged
  // fold reads oldest-first regardless of the order the Gate returned them.
  const stored: GroupTranscriptEntry[] = [
    { id: 'n-1', role: 'bot', botId: 'coder', text: 'done just now', at: NOW + 30_000 },
    { id: 'o-1', role: 'user', text: 'earlier exchange', at: NOW - 30_000 },
  ];
  expect(mergeTranscriptRows(current, stored)).toEqual([
    { id: 'o-1', role: 'user', text: 'earlier exchange', at: NOW - 30_000 },
    { id: 'u-1', role: 'user', text: 'go', at: NOW },
    { id: 'n-1', role: 'bot', botId: 'coder', text: 'done just now', at: NOW + 30_000 },
  ]);
});

test('mergeTranscriptRows sorts a stamp-less stored line as oldest, so replay keeps its place above the live rows', () => {
  const current = [{ id: 'u-1', role: 'user', text: 'go', at: NOW } as const];
  // Older gates do not stamp lines; without a stamp the stored replay line
  // reads as oldest and still lands above this visit's optimistic send.
  const stored: GroupTranscriptEntry[] = [{ id: 'x-1', role: 'user', text: 'legacy line' }];
  expect(mergeTranscriptRows(current, stored)).toEqual([
    { id: 'x-1', role: 'user', text: 'legacy line' },
    { id: 'u-1', role: 'user', text: 'go', at: NOW },
  ]);
});

test('mergeTranscriptRows skips the Gate copy of a send made this visit — same text, same window — and keeps the richer local row', () => {
  const local = {
    id: 'u-1752000001000',
    role: 'user',
    text: 'status?',
    at: NOW,
    replyCount: 2,
    speakerCount: 2,
    routableCount: 2,
    silentNames: [],
    unknownNames: [],
    rosterLoaded: true,
  } as const;
  const localReplies: TranscriptRowLike[] = [
    { id: 'u-1752000001000-r0', role: 'bot', botId: 'coder', text: 'all green', at: NOW + 40 },
    { id: 'u-1752000001000-r1', role: 'bot', botId: 'writer', text: 'copy checks out', at: NOW + 40 },
  ];
  const current = [local, ...localReplies];
  // The Gate stamps the send with its own clock and a random id — a few ms
  // on, never the phone's `u-<ts>` — so id-dedupe alone would duplicate it.
  const stored: GroupTranscriptEntry[] = [
    { id: 'cafe01', role: 'user', text: 'status?', at: NOW + 4 },
    { id: 'cafe02', role: 'bot', botId: 'coder', text: 'all green', at: NOW + 4 },
    { id: 'cafe03', role: 'bot', botId: 'writer', text: 'copy checks out', at: NOW + 4 },
  ];
  const merged = mergeTranscriptRows(current, stored);
  // The whole round reads as one send: nothing from storage is added, and
  // the local rows (with their outcome meta) survive untouched.
  expect(merged).toEqual(current);
  expect(merged[0]).toBe(local);
});

test('mergeTranscriptRows skips the Gate copy of a bot reply from this visit', () => {
  const current: TranscriptRowLike[] = [
    {
      id: 'u-1-r0',
      role: 'bot',
      botId: 'coder',
      text: 'on it',
      at: NOW + 1_000,
    },
  ];
  const stored: GroupTranscriptEntry[] = [
    { id: 'd00d', role: 'bot', botId: 'coder', text: 'on it', at: NOW + 1_002 },
  ];
  expect(mergeTranscriptRows(current, stored)).toEqual(current);
});

test('mergeTranscriptRows treats an identical line stamped outside the send window as a NEW message', () => {
  const current = [{ id: 'u-1', role: 'user', text: 'again?', at: NOW } as const];
  const stored: GroupTranscriptEntry[] = [
    { id: 'g-9', role: 'user', text: 'again?', at: NOW + TRANSCRIPT_DEDUPE_WINDOW_MS + 1 },
  ];
  expect(mergeTranscriptRows(current, stored)).toEqual([
    { id: 'u-1', role: 'user', text: 'again?', at: NOW },
    { id: 'g-9', role: 'user', text: 'again?', at: NOW + TRANSCRIPT_DEDUPE_WINDOW_MS + 1 },
  ]);
});

test('mergeTranscriptRows treats a same-window line with different text as new', () => {
  const current = [{ id: 'u-1', role: 'user', text: 'first', at: NOW } as const];
  const stored: GroupTranscriptEntry[] = [
    { id: 'g-3', role: 'user', text: 'second', at: NOW + 500 },
  ];
  expect(mergeTranscriptRows(current, stored)).toHaveLength(2);
});

test('mergeTranscriptRows drops corrupt stored lines the same way the fold does', () => {
  const stored: GroupTranscriptEntry[] = [
    { id: 'a3', role: 'bot', text: 'no author' },
    { id: 'a4', role: 'mystery', text: '?' } as unknown as GroupTranscriptEntry,
    null as unknown as GroupTranscriptEntry,
  ];
  // Nothing corrupt and nothing known: the view keeps exactly what it had.
  expect(mergeTranscriptRows([], stored)).toEqual([]);
});

test('mergeTranscriptRows: a successful empty read and a failed read both leave the conversation untouched', () => {
  const current = [{ id: 'u-1', role: 'user', text: 'keep me', at: NOW } as const];
  // Empty answer (or the adapter absent on older gates) is a no-op — the
  // transcript in front of the operator is the conversation, not a cached
  // inventory, so no refresh wipes it.
  expect(mergeTranscriptRows(current, [])).toEqual(current);
});

test('mergeTranscriptRows dedupes the Gate copy when the Gate clock runs AHEAD of the phone (skew > send window)', () => {
  // The Gate stamps this phone's send with its own clock; a desktop clock
  // minutes ahead of the phone made the copy fall OUTSIDE the old 60s window,
  // so every refresh duplicated the operator's own bubble (rook 2026-08-25).
  // A +2min skew is still "the same message" — nothing is added.
  const local = {
    id: 'u-1752000001000',
    role: 'user',
    text: 'status?',
    at: NOW,
    replyCount: 2,
    speakerCount: 2,
    routableCount: 2,
    silentNames: [],
    unknownNames: [],
    rosterLoaded: true,
  } as const;
  const localReplies: TranscriptRowLike[] = [
    { id: 'u-1752000001000-r0', role: 'bot', botId: 'coder', text: 'all green', at: NOW + 40 },
    { id: 'u-1752000001000-r1', role: 'bot', botId: 'writer', text: 'copy checks out', at: NOW + 40 },
  ];
  const current = [local, ...localReplies];
  const skewMs = 120_000; // far past the old 60s window, inside the 5min budget
  const stored: GroupTranscriptEntry[] = [
    { id: 'cafe01', role: 'user', text: 'status?', at: NOW + skewMs },
    { id: 'cafe02', role: 'bot', botId: 'coder', text: 'all green', at: NOW + skewMs },
    { id: 'cafe03', role: 'bot', botId: 'writer', text: 'copy checks out', at: NOW + skewMs },
  ];
  expect(mergeTranscriptRows(current, stored)).toEqual(current);
});

test('mergeTranscriptRows dedupes the Gate copy when the Gate clock runs BEHIND the phone', () => {
  // Mirror case: the Gate stamps the copy BEFORE the phone's optimistic row.
  // Same role/text/botId within the budget — still one message, not two.
  const current: TranscriptRowLike[] = [
    { id: 'u-1', role: 'user', text: 'go', at: NOW },
    { id: 'u-1-r0', role: 'bot', botId: 'coder', text: 'on it', at: NOW + 1_000 },
  ];
  const stored: GroupTranscriptEntry[] = [
    { id: 'beef01', role: 'user', text: 'go', at: NOW - 120_000 },
    { id: 'beef02', role: 'bot', botId: 'coder', text: 'on it', at: NOW - 120_000 + 2 },
  ];
  expect(mergeTranscriptRows(current, stored)).toEqual(current);
});

test('mergeTranscriptRows keeps an identical line stamped BEYOND the skew budget as a new message', () => {
  // The budget stays finite on both sides: a line stamped further out than
  // the window cannot be told apart from a genuinely new one, so it keeps
  // its own place instead of being swallowed. (10 minutes either way.)
  const current = [{ id: 'u-1', role: 'user', text: 'again?', at: NOW } as const];
  const stored: GroupTranscriptEntry[] = [
    { id: 'g-10', role: 'user', text: 'again?', at: NOW - TRANSCRIPT_DEDUPE_WINDOW_MS - 60_000 },
  ];
  expect(mergeTranscriptRows(current, stored)).toEqual([
    { id: 'g-10', role: 'user', text: 'again?', at: NOW - TRANSCRIPT_DEDUPE_WINDOW_MS - 60_000 },
    { id: 'u-1', role: 'user', text: 'again?', at: NOW },
  ]);
});

test('canAddMember holds the six-member ceiling', () => {
  const two: BotGroupRoom = { id: 'r', name: 'n', memberIds: ['a', 'b'] };
  const full: BotGroupRoom = { id: 'r', name: 'n', memberIds: ['1', '2', '3', '4', '5', '6'] };
  expect(canAddMember(two)).toBe(true);
  expect(canAddMember(full)).toBe(false);
});

test('addableMembers offers routable bots not already in the room, in roster order', () => {
  const bots = [
    { id: 'coder', displayName: 'Coder', routable: true },
    { id: 'researcher', displayName: 'Researcher', routable: true },
    { id: 'reviewer', displayName: 'Reviewer', routable: true },
    { id: 'ghost', displayName: 'Ghost', routable: false },
  ];
  const emptyRoom: BotGroupRoom = { id: 'r', name: 'n', memberIds: [] };
  // The room's own members never come back as addable, and unroutable bots
  // are excluded — the same eligibility the create-room chips follow.
  expect(addableMembers(ROOM, bots).map((bot) => bot.id)).toEqual(['reviewer']);
  expect(addableMembers(emptyRoom, bots).map((bot) => bot.id)).toEqual([
    'coder',
    'researcher',
    'reviewer',
  ]);
});

test('removableMembers offers every current member in room order, labeled through the inventory', () => {
  const names = new Map([
    ['coder', 'Coder'],
    ['researcher', 'Researcher'],
  ]);
  const three: BotGroupRoom = { id: 'r', name: 'n', memberIds: ['coder', 'ghost', 'researcher'] };
  // Room order, resolved labels; a member the inventory has never seen keeps
  // its raw id and is flagged unknown — never an invented name.
  expect(removableMembers(three, names)).toEqual([
    { id: 'coder', label: 'Coder', unknown: false },
    { id: 'ghost', label: 'ghost', unknown: true },
    { id: 'researcher', label: 'Researcher', unknown: false },
  ]);
});

test('removableMembers offers nothing at the two-member floor', () => {
  // The floor makes every remaining member structural: canRemoveMember is
  // false at 2, so the picker shows the floor reason instead of chips.
  expect(removableMembers(ROOM, new Map())).toEqual([]);
  expect(removableMembers(ROOM, new Map([['coder', 'Coder']]))).toEqual([]);
});

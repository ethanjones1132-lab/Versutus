import {
  canRemoveMember,
  describeGroupPlan,
  filterGroupRooms,
  GROUP_MEMBER_FLOOR_REASON,
  GROUP_SESSION_TITLE,
  groupMemberLine,
  groupSpeakers,
  MAX_GROUP_MESSAGES,
  MAX_GROUP_ROUNDS,
  planGroupRounds,
  validateGroup,
} from '@/lib/gateway/groups';
import type { BotGroupRoom } from '@/lib/gateway/groups';

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

import { GROUP_SESSION_TITLE, planGroupRounds, validateGroup } from '@/lib/gateway/groups';

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

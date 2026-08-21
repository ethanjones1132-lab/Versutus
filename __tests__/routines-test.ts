import { parseRoutineName, routineName } from '@/lib/gateway/routines';

test('routineName namespaces a job to a bot', () => {
  expect(routineName('researcher', 'inbox')).toBe('[bot:researcher] inbox');
  expect(parseRoutineName('[bot:researcher] inbox')).toEqual({ botId: 'researcher', title: 'inbox' });
  expect(parseRoutineName('plain')).toEqual({ title: 'plain' });
});

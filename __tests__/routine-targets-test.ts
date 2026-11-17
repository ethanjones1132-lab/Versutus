import { routineTargets } from '@/lib/routines/targets';

test('routine targets require read-backed support and use backend ids, never backend names', () => {
  const targets = routineTargets(
    [
      { id: 'cc-01', label: 'Claude Code', status: 'complete' },
      { id: 'codex-01', label: 'Codex', status: 'unavailable' },
    ],
    [],
    [],
  );
  expect(targets).toEqual([
    { key: 'backend:cc-01', label: 'Claude Code', kind: 'Backend', scope: { backendId: 'cc-01', botId: null } },
  ]);
});

test('an empty but supported backend remains available as a routine target', () => {
  expect(routineTargets(
    [{ id: 'opencode-01', label: 'OpenCode', status: 'complete' }],
    [],
    [],
  )).toEqual([
    {
      key: 'backend:opencode-01',
      label: 'OpenCode',
      kind: 'Backend',
      scope: { backendId: 'opencode-01', botId: null },
    },
  ]);
});

test('rows prove backend support and expose known Bot targets even if the Bot list is unavailable', () => {
  const targets = routineTargets(
    [{ id: 'open-01', label: 'OpenCode', status: 'failed' }],
    [{ id: 'r1', backendId: 'open-01', botId: 'research', name: 'Daily', paused: false }],
    [],
  );
  expect(targets).toEqual([
    { key: 'backend:open-01', label: 'OpenCode', kind: 'Backend', scope: { backendId: 'open-01', botId: null } },
    { key: 'bot:open-01:research', label: 'research', kind: 'Bot', scope: { backendId: 'open-01', botId: 'research' } },
  ]);
});

test('a Bot with no explicit backend or read-backed row is not guessed into one', () => {
  expect(routineTargets(
    [{ id: 'codex', label: 'Codex', status: 'complete' }],
    [],
    [{ id: 'writer', displayName: 'Writer', routable: true }],
  )).toHaveLength(1);
});

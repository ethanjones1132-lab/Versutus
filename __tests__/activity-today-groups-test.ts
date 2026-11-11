import {
  filterActivityByBackend,
  groupActivityForToday,
} from '@/lib/activity/today';
import type { ActivityCoverage, ActivityItem } from '@/lib/gateway/activity-feed';

const coverage: ActivityCoverage[] = [
  { id: 'b', label: 'Beta', status: 'complete' },
  { id: 'a', label: 'Alpha', status: 'complete' },
];
const item = (id: string, backendId: string, botId?: string): ActivityItem => ({
  id,
  backendId,
  ...(botId ? { botId } : {}),
  kind: 'session',
  sessionId: id,
  startedAt: '2026-11-10T12:00:00Z',
  status: 'complete',
  title: id,
  metrics: {},
});

describe('Today activity grouping', () => {
  test('groups by a known Bot and displays its name', () => {
    const groups = groupActivityForToday([item('one', 'b', 'bot-1')], coverage, [{ id: 'bot-1', displayName: 'Mira' }]);
    expect(groups).toEqual([{ key: 'backend:b:bot:bot-1', title: 'Beta · Mira', items: [item('one', 'b', 'bot-1')] }]);
  });

  test('groups by backend when no Bot is present', () => {
    expect(groupActivityForToday([item('one', 'b')], coverage, [])[0]?.title).toBe('Beta');
  });

  test('a chip narrows to its backend, and All keeps every row', () => {
    const items = [item('one', 'b'), item('two', 'a')];
    expect(filterActivityByBackend(items, 'b').map((row) => row.id)).toEqual(['one']);
    expect(filterActivityByBackend(items, undefined)).toBe(items);
  });

  test('an OpenCode Bot groups under Backend · Bot, apart from another Bot', () => {
    const items = [
      item('build-thread', 'b', 'opencode-build'),
      item('review-thread', 'b', 'opencode-review'),
    ];
    const groups = groupActivityForToday(items, coverage, [
      { id: 'opencode-build', displayName: 'Builder' },
      { id: 'opencode-review', displayName: 'Reviewer' },
    ]);
    expect(groups.map((group) => group.title)).toEqual(['Beta · Builder', 'Beta · Reviewer']);
    expect(groups.map((group) => group.items.map((row) => row.id))).toEqual([
      ['build-thread'],
      ['review-thread'],
    ]);
  });

  test('keeps an item whose backend is not in coverage', () => {
    const groups = groupActivityForToday([item('one', 'missing')], coverage, []);
    expect(groups[0]?.items).toEqual([item('one', 'missing')]);
  });

  test('orders groups by backend coverage order', () => {
    const groups = groupActivityForToday([item('alpha', 'a'), item('beta', 'b')], coverage, []);
    expect(groups.map((group) => group.title)).toEqual(['Beta', 'Alpha']);
  });
});

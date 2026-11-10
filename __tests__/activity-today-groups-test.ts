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

  test('keeps an item whose backend is not in coverage', () => {
    const groups = groupActivityForToday([item('one', 'missing')], coverage, []);
    expect(groups[0]?.items).toEqual([item('one', 'missing')]);
  });

  test('orders groups by backend coverage order', () => {
    const groups = groupActivityForToday([item('alpha', 'a'), item('beta', 'b')], coverage, []);
    expect(groups.map((group) => group.title)).toEqual(['Beta', 'Alpha']);
  });
});

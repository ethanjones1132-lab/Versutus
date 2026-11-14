import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('@/components/ui/ListRow', () => ({ ListRow: 'ListRow' }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({ accent: '#a0f', statusConnecting: '#fc0', statusDisconnected: '#f00', statusConnected: '#0f0' }),
}));

import { ActivityRow } from '@/components/activity/activity-row';

test('a session row shows last activity time instead of its older start time', () => {
  const item = {
    id: 'hermes:session:1',
    backendId: 'hermes',
    kind: 'session' as const,
    sessionId: 'session-1',
    startedAt: '2026-11-13T22:15:00.000Z',
    lastActiveAt: '2026-11-14T14:27:00.000Z',
    status: 'active',
    title: 'Long-running conversation',
    metrics: {},
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(ActivityRow, { item }));
  });
  const row = renderer.root.findByType('ListRow' as never);
  const subtitle = (row.props as { subtitle?: string }).subtitle;
  const expected = new Date(item.lastActiveAt);
  const expectedTime = `${String(expected.getHours()).padStart(2, '0')}:${String(expected.getMinutes()).padStart(2, '0')}`;
  const started = new Date(item.startedAt);
  const startedTime = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;
  expect(subtitle).toContain(expectedTime);
  expect(expectedTime).not.toBe(startedTime);
  expect(subtitle).not.toContain(startedTime);
});

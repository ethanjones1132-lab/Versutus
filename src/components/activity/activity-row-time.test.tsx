import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('@/components/ui/ListRow', () => ({ ListRow: 'ListRow' }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({ accent: '#a0f', statusConnecting: '#fc0', statusDisconnected: '#f00', statusConnected: '#0f0' }),
}));

import { ActivityRow } from '@/components/activity/activity-row';
import type { ActivityItem } from '@/lib/gateway/activity-feed';

const pad = (value: number) => String(value).padStart(2, '0');

/** A local wall-clock stamp relative to the device's today, never UTC. */
function at(dayOffset: number, hour: number, minute: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0);
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function day(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function run(overrides: Pick<ActivityItem, 'startedAt' | 'finishedAt' | 'status'>): ActivityItem {
  return {
    id: 'hermes:run:1',
    backendId: 'hermes',
    kind: 'run',
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt,
    status: overrides.status,
    title: 'Nightly index',
    metrics: {},
  };
}

function subtitleOf(item: ActivityItem): string {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(ActivityRow, { item }));
  });
  const row = renderer.root.findByType('ListRow' as never);
  return (row.props as { subtitle?: string }).subtitle ?? '';
}

test('an overnight run shows the time it finished, not the time it began yesterday', () => {
  const started = at(-1, 23, 50);
  const finished = at(0, 0, 10);
  const subtitle = subtitleOf(run({
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    status: 'completed',
  }));
  expect(subtitle).toContain('00:10');
  expect(subtitle).not.toContain('23:50');
  // Its anchor is today, so it takes no date — the date is for other days.
  expect(subtitle).not.toContain(day(started));
});

test('an ordinary same-day run still shows only its finish time', () => {
  const started = at(0, 9, 15);
  const finished = at(0, 9, 42);
  const subtitle = subtitleOf(run({
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    status: 'completed',
  }));
  expect(subtitle).toContain('09:42');
  expect(subtitle).not.toContain('09:15');
  expect(subtitle).not.toContain(day(finished));
});

test('a row anchored on another day carries that day beside its time', () => {
  const started = at(-1, 23, 50);
  const finished = at(-1, 23, 59);
  const subtitle = subtitleOf(run({
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    status: 'completed',
  }));
  expect(subtitle).toContain(`${day(finished)}, ${clock(finished)}`);
});

test('a run still moving is anchored at its start, dated when that start is another day', () => {
  const started = at(-1, 23, 55);
  const subtitle = subtitleOf(run({
    startedAt: started.toISOString(),
    finishedAt: at(-1, 23, 58).toISOString(),
    status: 'running',
  }));
  expect(subtitle).toContain(`${day(started)}, 23:55`);
  expect(subtitle).not.toContain('23:58');
});

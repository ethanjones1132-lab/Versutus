// VS-136: the routine detail sheet renders its schedule in words with the
// next run on the phone's clock, and a failed run carries the classified
// sentence chat failures already get (VS-127). A revert to the raw cron, the
// raw ISO timestamp, or the raw host error fails these assertions.

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Button: 'Button',
  ConfirmSheet: 'ConfirmSheet',
  Divider: 'Divider',
  ErrorCard: 'ErrorCard',
  ListRow: 'ListRow',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/lib/haptics', () => ({ haptics: { success: jest.fn(async () => undefined) } }));

const mockBotJobs = {
  run: jest.fn(async () => undefined),
  pause: jest.fn(async () => undefined),
  remove: jest.fn(async () => undefined),
};
const mockCron = {
  available: true,
  runs: jest.fn(async () => []),
  list: jest.fn<Promise<CronJob[]>, []>(async () => []),
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({ botJobs: mockBotJobs, cron: mockCron }),
}));

jest.mock('@/lib/notifications/routine-sync', () => ({
  syncRoutineNotification: jest.fn(async () => undefined),
  cancelRoutineNotification: jest.fn(async () => undefined),
}));

import { createElement, type ElementType, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import type { CronJob } from '@/lib/gateway/cron';
import { formatRunFailure } from '@/lib/gateway/run-failures';
import { formatScheduleTime } from '@/lib/routines/schedule';

const TEXT = 'Text' as ElementType;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NINE = formatScheduleTime(9, 0, false);

let renderer: ReactTestRenderer | null = null;

function flatten(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).join('');
  return '';
}

function textContent(): string {
  const nodes = renderer?.root.findAllByType(TEXT) ?? [];
  return nodes.map((node) => flatten(node.props.children)).join('\n');
}

async function open(job: CronJob): Promise<void> {
  // The full-detail read confirms the same record, so the Latest Run section
  // renders from it rather than the "could not be checked" fallback.
  mockCron.list.mockResolvedValue([job]);
  await act(async () => {
    renderer = create(
      createElement(CronJobSheet, { job, onClose: () => undefined, onOpenRun: () => undefined }),
    );
  });
  // The sheet's run-history read is deferred one tick, like every loader.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllMocks();
});

test('a daily routine reads its schedule in words and its next run in local time', async () => {
  const next = new Date();
  next.setDate(next.getDate() + 2);
  next.setHours(9, 0, 0, 0);
  const nextRunAt = next.toISOString();

  await open({
    id: 'job-1',
    title: 'Nightly digest',
    schedule: '0 9 * * *',
    nextRunAt,
  } as CronJob);

  const text = textContent();
  expect(text).toContain(`Every day at ${NINE}`);
  expect(text).toContain(`${WEEKDAYS[next.getDay()]} at 09:00`);
  // Neither the cron expression nor the wire timestamp reaches the reader.
  expect(text).not.toContain('0 9 * * *');
  expect(text).not.toContain(nextRunAt);
});

test('a failed run shows the same classified sentence chat failures get', async () => {
  const raw = 'no assistant content';
  const classified = formatRunFailure(raw);
  expect(classified).not.toBeNull();

  await open({
    id: 'job-1',
    title: 'Nightly digest',
    schedule: '0 9 * * *',
    latestExecution: {
      status: 'failed',
      started_at: '2026-11-14T18:20:00.000Z',
      finished_at: '2026-11-14T18:20:14.000Z',
      error: raw,
    },
  } as CronJob);

  const text = textContent();
  expect(text).toContain(classified as string);
  // The verdict and fix are the classifier's, not a paraphrase of the CLI error.
  expect(text).toContain('The model did not answer');
  expect(text).toContain('Pick a model from a signed-in provider');
});

test('an unknown host error still shows its own words, unchanged', async () => {
  await open({
    id: 'job-1',
    title: 'Nightly digest',
    latestExecution: { status: 'failed', error: 'The provider refused the model.' },
  } as CronJob);

  expect(textContent()).toContain('The provider refused the model.');
});

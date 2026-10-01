// The phone-side "due" notice a routine's schedule maps to has to follow the
// state the host confirmed. This branches on `paused` — the value read BEFORE
// the toggle — so Pause called syncRoutineNotification (which schedules a
// "due" notice for a routine that will never run) and Resume called
// cancelRoutineNotification (which silences a live notice until the next
// connected re-arm). Bot Chat's own pane already gets this right; the sheet
// below is the one that does not.

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
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
  ListRow: 'ListRow',
  Skeleton: 'Skeleton',
  Text: 'Text',
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
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({ botJobs: mockBotJobs, cron: mockCron }),
}));

jest.mock('@/lib/notifications/routine-sync', () => ({
  syncRoutineNotification: jest.fn(async () => undefined),
  cancelRoutineNotification: jest.fn(async () => undefined),
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import type { CronJob } from '@/lib/gateway/cron';
import {
  cancelRoutineNotification,
  syncRoutineNotification,
} from '@/lib/notifications/routine-sync';

const BUTTON = 'Button' as ElementType;
const sync = syncRoutineNotification as jest.Mock;
const cancel = cancelRoutineNotification as jest.Mock;

/** A Bot-owned routine: its name carries the `[bot:…]` prefix, so its notice is one. */
function botRoutine(paused: boolean): CronJob {
  return {
    id: 'job-1',
    title: 'Nightly mail summary',
    name: '[bot:scout] Nightly mail summary',
    botId: 'scout',
    schedule: '0 9 * * *',
    nextRunAt: '2026-10-02T09:00:00Z',
    paused,
  } as CronJob;
}

let renderer: ReactTestRenderer | null = null;

async function open(job: CronJob): Promise<void> {
  await act(async () => {
    renderer = create(
      createElement(CronJobSheet, { job, onClose: () => undefined, onOpenRun: () => undefined }),
    );
  });
}

async function pressPauseToggle(): Promise<void> {
  const toggle = renderer
    ?.root.findAllByType(BUTTON)
    .find((node) => node.props.label === 'Pause' || node.props.label === 'Resume');
  expect(toggle).toBeDefined();
  await act(async () => {
    toggle?.props.onPress();
  });
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

test('pausing a running routine retires its notice and never announces one', async () => {
  await open(botRoutine(false));

  await pressPauseToggle();

  expect(mockBotJobs.pause).toHaveBeenCalledWith('job-1', true);
  // A paused routine will not run, so nothing may be scheduled for it: the
  // held notice is retired and no "due" notice is built.
  expect(cancel).toHaveBeenCalledWith('job-1');
  expect(sync).not.toHaveBeenCalled();
});

test('resuming a paused routine rebuilds its notice from the host record', async () => {
  await open(botRoutine(true));

  await pressPauseToggle();

  expect(mockBotJobs.pause).toHaveBeenCalledWith('job-1', false);
  // A live routine must ring the phone again; the sync carries the record the
  // host reported, and the post-toggle `paused: false` so it takes the
  // scheduling branch rather than the pause one.
  expect(cancel).not.toHaveBeenCalled();
  expect(sync).toHaveBeenCalledWith({
    id: 'job-1',
    name: '[bot:scout] Nightly mail summary',
    schedule: '0 9 * * *',
    nextRunAt: '2026-10-02T09:00:00Z',
    paused: false,
  });
});

test('a refused pause changes no notice at all', async () => {
  mockBotJobs.pause.mockRejectedValueOnce(new Error('job "job-1" is locked'));
  await open(botRoutine(false));

  await pressPauseToggle();

  expect(sync).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
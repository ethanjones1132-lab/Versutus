// The cron roster was read twice in the same tick on mount — once from the
// section's own mount effect and once from the focus effect — and every later
// caller (a return to the tab, a pull-to-refresh's reload signal) issued its
// own independent read with no in-flight guard and no record of which read owns
// the rows on screen, so a slow older read could paint over a newer list.
// These pin: exactly one read per focus, a second caller joining the read in
// flight, and the newest list on screen. The create form's phone-side notice
// is pinned too: a gateway-level job names no Bot, so there is no notice to
// schedule and the call that claimed otherwise did nothing.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Button: 'Button',
  Card: 'Card',
  EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard',
  ListRow: 'ListRow',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/components/activity/cron-job-sheet', () => ({ CronJobSheet: 'CronJobSheet' }));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));

/** The focus effect the section registered, so a refocus can be simulated. */
const mockFocus = { effect: null as null | (() => void | (() => void)) };

jest.mock('expo-router', () => {
  // Real semantics: the effect runs on the first focus.
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      mockFocus.effect = effect;
      useEffect(() => effect(), [effect]);
    },
  };
});

type Job = { id: string; title: string };

const mockCron: {
  available: boolean;
  /** Every `cron.list()` call, in order. */
  listCalls: number[];
  parks: ({ promise: Promise<Job[]>; resolve: (jobs: Job[]) => void } | null)[];
  answer: Job[];
  fails: boolean;
} = {
  available: true,
  listCalls: [],
  /** Resolves the read parked at this index; null answers at once. */
  parks: [] as ({ promise: Promise<Job[]>; resolve: (jobs: Job[]) => void } | null)[],
  answer: [] as Job[],
  fails: false,
};

/**
 * One stable object per seam, built per test: the real provider memoises
 * these, and a fresh identity on every render would re-run the section's focus
 * effect all by itself.
 */
let mockGateway: {
  status: string;
  cron: { available: boolean; list: () => Promise<Job[]> };
  botJobs: { create: (input: unknown) => Promise<unknown> };
} | null = null;

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

function gatewayValue(): NonNullable<typeof mockGateway> {
  return {
    status: 'connected',
    cron: {
      available: mockCron.available,
      list: async () => {
        const index = mockCron.listCalls.length;
        mockCron.listCalls.push(index);
        const park = mockCron.parks[index] ?? null;
        if (park) return park.promise;
        if (mockCron.fails) throw new Error('cron refused');
        return mockCron.answer;
      },
    },
    botJobs: { create: mockCreate },
  };
}

const mockCreate = jest.fn(async () => ({ id: 'job-new', name: 'Overnight mail summary' }));

jest.mock('@/lib/notifications/routine-sync', () => ({
  syncRoutineNotification: jest.fn(async () => undefined),
  cancelRoutineNotification: jest.fn(async () => undefined),
}));

import {
  cancelRoutineNotification,
  syncRoutineNotification,
} from '@/lib/notifications/routine-sync';

const mockSync = syncRoutineNotification as jest.Mock;
const mockCancel = cancelRoutineNotification as jest.Mock;

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CronSection } from '@/components/activity/cron-section';

const BUTTON = 'Button' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;
const LIST_ROW = 'ListRow' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;

function job(id: string): Job {
  return { id, title: `Job ${id}` };
}

function park(index: number): { promise: Promise<Job[]>; resolve: (jobs: Job[]) => void } {
  let resolve: (jobs: Job[]) => void = () => undefined;
  const promise = new Promise<Job[]>((settle) => {
    resolve = settle;
  });
  mockCron.parks[index] = { promise, resolve };
  return mockCron.parks[index] as { promise: Promise<Job[]>; resolve: (jobs: Job[]) => void };
}

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

let renderer: ReactTestRenderer | null = null;

async function mount(signal = 0): Promise<void> {
  await act(async () => {
    renderer = create(createElement(CronSection, { cronReloadSignal: signal }));
  });
  // The section defers its first read a tick, like every other loader here.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

async function setSignal(signal: number): Promise<void> {
  const mounted = renderer;
  if (!mounted) return;
  await act(async () => {
    mounted.update(createElement(CronSection, { cronReloadSignal: signal }));
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

async function refocus(): Promise<void> {
  await act(async () => {
    mockFocus.effect?.();
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

async function release(index: number, jobs: Job[]): Promise<void> {
  await act(async () => {
    mockCron.parks[index]?.resolve(jobs);
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFocus.effect = null;
  mockCron.listCalls.length = 0;
  mockCron.parks.length = 0;
  mockCron.answer = [job('a'), job('b')];
  mockCron.fails = false;
  mockGateway = gatewayValue();
  mockCreate.mockClear();
  mockSync.mockClear();
  mockCancel.mockClear();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the cron roster is read once per focus', () => {
  it('mounting issues exactly one cron.list()', async () => {
    await mount();

    // The mount effect and the focus effect both used to fire on mount.
    expect(mockCron.listCalls).toEqual([0]);
  });

  it('returning to the tab reads again, exactly once', async () => {
    await mount();
    expect(mockCron.listCalls).toEqual([0]);

    await refocus();
    expect(mockCron.listCalls).toEqual([0, 1]);

    await refocus();
    expect(mockCron.listCalls).toEqual([0, 1, 2]);
  });

  it('a pull-to-refresh signal with no read in flight issues one read', async () => {
    await mount();
    expect(mockCron.listCalls).toEqual([0]);

    await setSignal(1);
    expect(mockCron.listCalls).toEqual([0, 1]);
  });
});

describe('a second caller joins the read in flight', () => {
  it('a reload signal arriving mid-read does not issue a second read', async () => {
    park(0);
    await mount();
    expect(mockCron.listCalls).toEqual([0]);

    await setSignal(1);
    await refocus();

    // One read out, three callers: the signal and the refocus both joined it.
    expect(mockCron.listCalls).toEqual([0]);

    await release(0, [job('joined')]);
    const titles = renderer?.root.findAllByType(LIST_ROW).map((node) => String(node.props.title));
    expect(titles).toEqual(['Job joined']);
  });

  it('a caller after the read answered gets a fresh read, not the old answer', async () => {
    park(0);
    await mount();
    await release(0, [job('first')]);
    expect(mockCron.listCalls).toEqual([0]);

    const second = park(1);
    await setSignal(1);

    // The settled read is not joinable: the pull wants the list as it is now.
    expect(mockCron.listCalls).toEqual([0, 1]);
    await release(1, [job('second')]);
    expect(second.promise).toBeDefined();
    const titles = renderer?.root.findAllByType(LIST_ROW).map((node) => String(node.props.title));
    expect(titles).toEqual(['Job second']);
  });

  it('a refused read releases the slot, so the next focus reads again', async () => {
    mockCron.fails = true;
    await mount();
    expect(mockCron.listCalls).toEqual([0]);
    const card = renderer?.root.findAllByType(ERROR_CARD)[0];
    expect(String(card?.props.cause)).toBe('cron refused');

    mockCron.fails = false;
    mockCron.parks.length = 0;
    await refocus();

    // A refused read must not leave the section permanently coalesced onto a
    // promise that has already failed.
    expect(mockCron.listCalls).toEqual([0, 1]);
  });
});

describe('the newest read owns the rows on screen', () => {
  // Two reads can no longer overlap, so a stale list cannot arrive late: the
  // caller that arrives while a read is out joins it, and the read that joins
  // is the one that paints. What the request generation guards is the paint
  // itself — a read that a newer generation has superseded never writes.
  it('a read that is still out when the pull arrives is the read that paints', async () => {
    park(0);
    await mount();

    await setSignal(1);
    await refocus();
    expect(mockCron.listCalls).toEqual([0]);

    await release(0, [job('only')]);
    const titles = renderer?.root.findAllByType(LIST_ROW).map((node) => String(node.props.title));
    expect(titles).toEqual(['Job only']);
  });

  it('the next read replaces that list, not the other way round', async () => {
    await mount();
    expect(renderer?.root.findAllByType(LIST_ROW)).toHaveLength(2);

    park(1);
    await setSignal(1);
    await release(1, [job('newer')]);

    const titles = renderer?.root.findAllByType(LIST_ROW).map((node) => String(node.props.title));
    expect(titles).toEqual(['Job newer']);
  });
});

// A gateway-level job files with no `[bot:…]` prefix on purpose, so the
// phone-side "due" notice has no Bot to name and `syncRoutineNotification`
// retires and returns — it cannot schedule anything. The call that claimed
// otherwise did nothing but cost a storage read on every create.
test('creating a gateway-level job schedules no routine notice and still re-lists', async () => {
  await mount();
  expect(mockCron.listCalls).toEqual([0]);

  const fields = renderer?.root.findAllByType(TEXT_FIELD) ?? [];
  await act(async () => {
    fields[0]?.props.onChangeText('Overnight mail summary');
  });
  await act(async () => {
    fields[1]?.props.onChangeText('0 9 * * *');
  });
  await act(async () => {
    fields[2]?.props.onChangeText('Summarize overnight mail');
  });

  const add = renderer?.root.findAllByType(BUTTON).find((node) => node.props.label === 'Add');
  expect(add).toBeDefined();
  expect(add?.props.disabled).toBe(false);
  await act(async () => {
    add?.props.onPress();
    await Promise.resolve();
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });

  expect(mockCreate).toHaveBeenCalledTimes(1);
  // No notice is built for a job that names no Bot, so nothing is synced…
  expect(mockSync).not.toHaveBeenCalled();
  expect(mockCancel).not.toHaveBeenCalled();
  // …and the create still landed: the draft cleared and the roster was re-read.
  expect(mockCron.listCalls).toEqual([0, 1]);
  const draft = renderer?.root.findAllByType(TEXT_FIELD);
  expect(draft?.[0]?.props.value).toBe('');
  expect(draft?.[2]?.props.value).toBe('');
  expect(stringsIn(renderer?.toJSON())).not.toContain('Adding…');
});
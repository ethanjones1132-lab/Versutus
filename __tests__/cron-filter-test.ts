import { filterCronJobsByTitle, type CronJob } from '@/lib/gateway/cron';

const job = (id: string, title: string): CronJob => ({ id, title });

describe('filterCronJobsByTitle', () => {
  test('a non-matching query keeps only the jobs whose title contains it, in order', () => {
    const jobs = [job('a', 'Overnight mail summary'), job('b', 'Daily standup'), job('c', 'mail digest')];
    expect(filterCronJobsByTitle(jobs, 'mail').map((j) => j.id)).toEqual(['a', 'c']);
  });

  test('the match is case-insensitive', () => {
    const jobs = [job('a', 'Overnight Mail')];
    expect(filterCronJobsByTitle(jobs, 'overnight MAIL').map((j) => j.id)).toEqual(['a']);
    expect(filterCronJobsByTitle(jobs, 'OVERNIGHT').map((j) => j.id)).toEqual(['a']);
  });

  test('an empty or whitespace-only query answers the SAME array reference, byte-identical', () => {
    // The idle field must be a no-op, not a copy: the untouched list the
    // section already holds renders exactly as before.
    const jobs = [job('a', 'One'), job('b', 'Two')];
    expect(filterCronJobsByTitle(jobs, '')).toBe(jobs);
    expect(filterCronJobsByTitle(jobs, '   ')).toBe(jobs);
  });

  test('no match answers an empty list, which the section renders as nothing — never a lie', () => {
    const jobs = [job('a', 'One')];
    const filtered = filterCronJobsByTitle(jobs, 'nothing matches');
    expect(filtered).toEqual([]);
  });

  test('input is untouched: the fold filters, it does not mutate', () => {
    const jobs = [job('a', 'One'), job('b', 'Two')];
    filterCronJobsByTitle(jobs, 'Two');
    expect(jobs).toHaveLength(2);
  });

  test('a job with an empty title matches nothing but exists — it is never dropped by accident', () => {
    // Wait: an empty-TITLE row cannot match a real query, but it is not
    // silently repaired either; the row's id is its fallback label upstream,
    // and filtering is over title only, honestly.
    const jobs = [job('a', '')];
    expect(filterCronJobsByTitle(jobs, 'a')).toEqual([]);
  });
});


// The component regression lives with the title-filter tests. The existing
// single-read suite keeps its original cases and remains unchanged.
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
  Badge: 'Badge', Button: 'Button', Card: 'Card', EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard', ListRow: 'ListRow', Skeleton: 'Skeleton',
  Text: 'Text', TextField: 'TextField',
}));
jest.mock('@/components/activity/cron-job-sheet', () => ({ CronJobSheet: 'CronJobSheet' }));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));
const mockFocus = { effect: null as null | (() => void | (() => void)) };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      mockFocus.effect = effect;
      useEffect(() => effect(), [effect]);
    },
  };
});
const mockCron = { answer: [] as CronJob[] };
const mockGateway = {
  status: 'connected',
  cron: { available: true, list: async () => mockCron.answer },
  botJobs: { create: jest.fn(async () => ({ id: 'unused' })) },
};
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { CronSection } from '@/components/activity/cron-section';

const TEXT_FIELD = 'TextField' as ElementType;
const LIST_ROW = 'ListRow' as ElementType;
let renderer: ReactTestRenderer | null = null;
const filterJob = (id: string): CronJob => ({ id, title: `Job ${id}` });

async function mount(): Promise<void> {
  await act(async () => { renderer = create(createElement(CronSection)); });
  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
}
async function refocus(): Promise<void> {
  await act(async () => { mockFocus.effect?.(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
}

// The filter field and its Clear button only render above three jobs. A filter
// set while the field was visible used to keep narrowing the list after the
// field vanished, leaving rows hidden with no visible cause and no way back.
describe('a title filter never outlives the field that shows it', () => {

  beforeEach(() => { jest.useFakeTimers(); mockFocus.effect = null; });
  afterEach(async () => {
    if (renderer) {
      const doomed = renderer;
      renderer = null;
      await act(async () => { doomed.unmount(); });
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  it('three jobs with a filter still set render every row, and the field is gone', async () => {
    mockCron.answer = [filterJob('a'), filterJob('b'), filterJob('c'), filterJob('d')];
    await mount();
    expect(renderer?.root.findAllByType(LIST_ROW)).toHaveLength(4);

    const filter = renderer?.root
      .findAllByType(TEXT_FIELD)
      .find((node) => node.props.placeholder === 'Filter by title');
    expect(filter).toBeDefined();
    await act(async () => {
      filter?.props.onChangeText('Job a');
    });
    expect(renderer?.root.findAllByType(LIST_ROW)).toHaveLength(1);

    // The roster shrinks under the still-set query: the field disappears, so
    // the narrowing must stop with it.
    mockCron.answer = [filterJob('a'), filterJob('b'), filterJob('c')];
    await refocus();

    const titles = renderer?.root.findAllByType(LIST_ROW).map((node) => String(node.props.title));
    expect(titles).toEqual(['Job a', 'Job b', 'Job c']);
    expect(
      renderer?.root
        .findAllByType(TEXT_FIELD)
        .filter((node) => node.props.placeholder === 'Filter by title'),
    ).toHaveLength(0);
  });
});

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
